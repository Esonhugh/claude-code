import { runModSessionCompact } from './compactAdapter.js'
import { createModToolHost } from './toolHost.js'
import { z } from 'zod/v4'
import { buildTool, getEmptyToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { resetSettingsCache, setCachedSettingsForSource, setSessionSettingsCache } from '../../utils/settings/settingsCache.js'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime, type ModsRuntime } from './runtime.js'
import { ToolSearchTool } from '../../tools/ToolSearchTool/ToolSearchTool.js'
const roots: string[] = []
const runtimes: ModsRuntime[] = []
beforeEach(() => {
  resetSettingsCache()
  setSessionSettingsCache({settings:{},errors:[]})
  for (const source of ['userSettings','projectSettings','localSettings','flagSettings','policySettings'] as const)
    setCachedSettingsForSource(source,{})
})
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  resetSettingsCache()
})
async function plugin(name: string, source: string) {
  const root = await mkdtemp(join(tmpdir(), 'mods-tool-host-'))
  roots.push(root)
  const pluginRoot = join(root, name)
  await mkdir(pluginRoot)
  const entry = join(pluginRoot, 'register.ts')
  await writeFile(entry, source)
  return { name, storageId: name + '@test', pluginRoot, entrypoints: [entry] }
}
const binding = { cwd: '/tmp', surface: null, isInteractive: false, sessionId: 'offline' } as const

test('ToolSearch description consumers execute author calls with the current tools and permissions', async () => {
  const mod=await plugin('search-host',`export function register(on) {
    on('tool.describe',{tool:'Offline'},async ($,e,next)=>{
      const result=await $.tool.call({tool:'Offline',value:'description'});
      return {...await next(e),description:result.text,isDeferred:true};
    });
  }`)
  const diagnostics: unknown[]=[],calls: string[]=[],permissions: string[]=[]
  const tool=buildTool({
    name:'Offline',inputSchema:z.object({value:z.string()}),maxResultSizeChars:1000,
    description:async()=>'unrelated',prompt:async()=>'unrelated',renderToolUseMessage:()=>null,
    call:async input=>{calls.push(input.value);return {data:'needlecapability'}},
    mapToolResultToToolResultBlockParam:(data,id)=>({type:'tool_result',tool_use_id:id,content:data}),
  })
  const runtime=createModsRuntime({onDiagnostic:event=>diagnostics.push(event),services:{
    toolHost:()=>{throw Error('stale session tool host')},
  }})
  runtimes.push(runtime)
  await runtime.bind(binding)
  await runtime.reconcile([mod])
  const context={
    mods:runtime,options:{tools:[tool],mcpClients:[],isNonInteractiveSession:true,agentDefinitions:{activeAgents:[]}},
    messages:[],abortController:new AbortController(),
    getAppState:()=>({toolPermissionContext:getEmptyToolPermissionContext(),sessionHooks:new Map(),mcp:{clients:[]}}),
    setAppState:()=>{},setInProgressToolUseIDs:()=>{},
  } as unknown as ToolUseContext
  const result=await ToolSearchTool.call({query:'needlecapability',max_results:5},context,async tool=>{
    permissions.push(tool.name);return {behavior:'allow'}
  })
  expect(diagnostics).toEqual([])
  expect(result.data.matches).toEqual(['Offline'])
  expect(calls).toEqual(['description'])
  expect(permissions).toEqual(['Offline'])
})

test('session.start tool.register publishes a real owned tool and replaces it atomically on reload', async () => {
  const source = (description: string) => `export function register(on) {
    on('session.start',async ($,e,next) => {await $.tool.register({name:'echo',description:'${description}',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}});return next(e)});
    on('tool.call',{tool:'mcp__dynamic__echo'},($,e) => ({result:e.text}));
  }`
  const mod = await plugin('dynamic',source('first'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event)})
  runtimes.push(runtime)
  await runtime.reconcile([mod])
  expect(diagnostics).toEqual([])
  await runtime.bind(binding)
  expect(diagnostics).toEqual([])
  const original = runtime.tools.projection([])
  expect(original.map(tool => tool.name)).toEqual(['mcp__dynamic__echo'])
  const held = runtime.capture()
  try {
    await writeFile(mod.entrypoints[0]!,source('second'))
    await runtime.reconcile([mod])
    const replaced = runtime.tools.projection(original)
    expect(replaced).toHaveLength(1)
    expect(replaced[0]).not.toBe(original[0])
    expect(await replaced[0]!.description({},{} as never)).toBe('second')
    await runtime.reconcile([])
    expect(runtime.tools.projection(replaced)).toEqual([])
    expect(await held.dispatch('tool.call',{tool:'mcp__dynamic__echo',text:'pinned'},async () => ({result:'core'}))).toEqual({result:'pinned'})
    expect(diagnostics).toEqual([])
  } finally {held.release()}
})


test('a conflicting replacement keeps both published owners and the prior callable generation', async () => {
  const first = await plugin('scope.one',`export function register(on) {
    on('session.start',async ($,e,next) => {await $.tool.register({name:'shared',description:'first owner'});return next(e)});
  }`)
  const source = (name: string, generation: string) => `export function register(on) {
    on('session.start',async ($,e,next) => {await $.tool.register({name:'${name}',description:'${generation}'});return next(e)});
    on('tool.call',{tool:'mcp__scope_one__separate'},()=>({result:'${generation}'}));
  }`
  const second = await plugin('scope_one',source('separate','previous'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event)})
  runtimes.push(runtime)
  await runtime.bind(binding)
  await runtime.reconcile([first,second])
  expect(diagnostics).toEqual([])
  const previous = [...runtime.tools.list()]
  expect(previous.map(tool => tool.name)).toEqual(['mcp__scope_one__shared','mcp__scope_one__separate'])
  await writeFile(second.entrypoints[0]!,source('shared','candidate'))
  await runtime.reconcile([first,second])
  expect(runtime.tools.list()).toEqual(previous)
  expect(await runtime.dispatch('tool.call',{tool:'mcp__scope_one__separate'},async()=>({result:'core'}))).toEqual({result:'previous'})
  expect(diagnostics).toContainEqual(expect.objectContaining({stage:'session.start',message:expect.stringContaining('already owned')}))
})


test('tool.register policy rewrites its schema but cannot forge the registering plugin ownership', async () => {
  const caller = await plugin('owned',`export function register(on) {
    on('session.start',async ($,e,next) => {await $.tool.register({name:'echo',description:'original'});return next(e)});
  }`)
  const policy = await plugin('policy',`export function register(on) {
    on('tool.register',($,e,next) => {
      if(next.origin.plugin!=='owned'||e.inputSchema.type!=='object') throw Error('missing identity or default schema');
      return next({...e,name:'changed',description:'rewritten',inputSchema:{type:'object',properties:{n:{type:'integer'}},required:['n']}});
    });
  }`)
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event)})
  runtimes.push(runtime)
  await runtime.bind(binding)
  await runtime.reconcile([caller,policy])
  const tools = runtime.tools.list()
  expect(tools.map(tool => tool.name)).toEqual(['mcp__owned__changed'])
  expect(tools[0]!.inputSchema.safeParse({n:1}).success).toBe(true)
  expect(tools[0]!.inputSchema.safeParse({n:'1'}).success).toBe(false)
  expect(diagnostics).toEqual([])
})


test('tool.register requires binding, rejects invalid schemas, and supports later same-owner replacement', async () => {
  const mod = await plugin('late', `export function register(on) {
    on('command.run',async ($,e) => {
      try {return {text:JSON.stringify(await $.tool.register(e.spec))}}
      catch(error) {return {text:error.message}}
    });
  }`)
  const runtime = createModsRuntime()
  runtimes.push(runtime)
  await runtime.reconcile([mod])
  const spec = {name:'echo',description:'first'}
  expect(await runtime.dispatch('command.run',{spec},async () => ({}))).toEqual({text:'tool.register requires a bound session'})
  expect(runtime.tools.projection([])).toEqual([])
  await runtime.bind(binding)
  expect(await runtime.dispatch('command.run',{spec},async () => ({}))).toEqual({text:JSON.stringify({tool:'mcp__late__echo'})})
  const first = runtime.tools.projection([])
  expect(first).toHaveLength(1)
  await runtime.dispatch('command.run',{spec:{...spec,description:'second'}},async () => ({}))
  expect(await runtime.tools.projection(first)[0]!.description({},{} as never)).toBe('second')
  const invalid = await runtime.dispatch('command.run',{spec:{...spec,inputSchema:null}},async () => ({}))
  expect((invalid as {text:string}).text).toMatch(/schema|Schema/)
  expect(await runtime.tools.projection(first)[0]!.description({},{} as never)).toBe('second')
})


test('author registration cannot shadow a real session tool or its alias', async () => {
  const mod = await plugin('owned', `export function register(on) {
    on('command.run',async ($,e) => {
      try {return {text:JSON.stringify(await $.tool.register(e.spec))}}
      catch(error) {return {text:error.message}}
    });
  }`)
  const tool = buildTool({
    name:'mcp__owned__existing',aliases:['mcp__owned__alias'],
    inputSchema:z.object({}),maxResultSizeChars:1000,
    description:async () => 'session tool',prompt:async () => 'session tool',
    call:async () => ({data:'original'}),renderToolUseMessage:() => null,
    mapToolResultToToolResultBlockParam:(data,id) => ({type:'tool_result',tool_use_id:id,content:data}),
  })
  const runtime = createModsRuntime()
  runtimes.push(runtime)
  const context = {mods:runtime,options:{tools:[tool]},abortController:new AbortController()} as unknown as ToolUseContext
  await runtime.bind(binding)
  await runtime.reconcile([mod])
  const snapshot = runtime.capture({tools:() => context.options.tools})
  try {
    for (const name of ['existing','alias']) {
      const result = await snapshot.dispatch('command.run',{spec:{name,description:'shadow'}},async () => ({})) as {text:string}
      expect(result.text).toContain('conflicts')
    }
    expect(runtime.tools.list()).toEqual([])
    expect(runtime.tools.projection(context.options.tools)).toEqual([tool])
    await snapshot.dispatch('command.run',{spec:{name:'safe',description:'first'}},async () => ({}))
    context.options.tools = runtime.tools.projection(context.options.tools)
    const result = await snapshot.dispatch('command.run',{spec:{name:'safe',description:'second'}},async () => ({}))
    expect(result).toEqual({text:JSON.stringify({tool:'mcp__owned__safe'})})
    expect(await runtime.tools.list()[0]!.description({},{} as never)).toBe('second')
    expect(runtime.tools.projection(context.options.tools).map(tool=>tool.name)).toEqual([tool.name,'mcp__owned__safe'])
  } finally {snapshot.release()}
})

test('author tool.call keeps its result envelope and origin while running sibling middleware', async () => {
  const caller = await plugin('caller', `let entries=0; export function register(on) {
    on('command.run', async $ => ({text:JSON.stringify({...await $.tool.call({tool:'Offline',value:1}),entries})}));
    on('tool.call', ($,e,next) => {entries++;return next({...e,value:e.value+1})});
  }`)
  const policy = await plugin('policy', `export function register(on) {
    on('tool.call', ($,e,next) => {
      if(next.origin.plugin!=='caller') throw Error('wrong origin');
      return next({...e,value:e.value+1});
    });
  }`)
  const diagnostics: unknown[] = []
  const origins: (string | undefined)[] = []
  const runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event),services:{
    toolHost: () => ({
      call: async (input, snapshot, signal, spawnedBy) => {
        origins.push(spawnedBy)
        return snapshot.dispatch('tool.call',input,async e => ({result:e.value,text:'mapped'}),{signal})
      },
      check: async () => ({decision:'allow'}),
    }),
  }})
  runtimes.push(runtime)
  await runtime.bind(binding)
  await runtime.reconcile([caller,policy])
  expect(diagnostics).toEqual([])
  expect(await runtime.dispatch('command.run',{},async () => ({}))).toEqual({text:JSON.stringify({result:3,text:'mapped',entries:1})})
  expect(origins).toEqual(['caller'])
  expect(diagnostics).toEqual([])
})

test('author tool.check refuses identity rewrites and invalid decisions at the hook boundary', async () => {
  const caller = await plugin('caller', `export function register(on) {
    on('command.run', async $ => ({text:JSON.stringify(await $.tool.check({tool:'Offline',input:{path:'original'}}))}));
  }`)
  const policy = await plugin('policy', `export function register(on) {
    on('tool.check', ($,e,next) => next({...e,input:{path:'rewritten'}}));
    on('tool.check', () => ({decision:'yes'}));
  }`)
  const questions: unknown[] = []
  const diagnostics: {message:string}[] = []
  const runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event),services:{
    toolHost: () => ({call:async () => {throw Error('no execution')},check:async input => {questions.push(input);return {decision:'deny',reason:'original'}}}),
  }})
  runtimes.push(runtime)
  await runtime.reconcile([caller,policy])
  expect(diagnostics).toEqual([])
  expect(await runtime.dispatch('command.run',{},async () => ({}))).toEqual({text:JSON.stringify({decision:'deny',reason:'original'})})
  expect(questions).toEqual([{tool:'Offline',input:{path:'original'}}])
  expect(diagnostics.map(event => event.message)).toEqual([
    'tool.check cannot rewrite tool, input or tool_use_id',
    'tool.check must return { decision, reason?, rule? }',
  ])
})

test('author tool.call propagates invocation abort through the Worker into the host operation', async () => {
  const caller = await plugin('caller', `export function register(on) {
    on('command.run',async $ => ({text:JSON.stringify(await $.tool.call({tool:'Offline'}))}));
  }`)
  const entered = Promise.withResolvers<void>()
  let observed: AbortSignal | undefined
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event),services:{
    toolHost: () => ({
      call:async (_input,_snapshot,signal) => {
        observed=signal;entered.resolve()
        return new Promise((_resolve,reject) => signal.addEventListener('abort',() => reject(signal.reason),{once:true}))
      },
      check:async () => ({decision:'allow'}),
    }),
  }})
  runtimes.push(runtime)
  await runtime.reconcile([caller])
  expect(diagnostics).toEqual([])
  const controller = new AbortController()
  const result = runtime.dispatch('command.run',{},async () => ({}),{signal:controller.signal})
  expect(await Promise.race([entered.promise.then(() => 'entered'),result.then(() => diagnostics)])).toBe('entered')
  controller.abort()
  await expect(result).rejects.toThrow()
  expect(observed?.aborted).toBe(true)
})

test('author tool.check crosses the Worker and dispatches a pinned permission question without an execution', async () => {
  const caller = await plugin('caller', `export function register(on) {
    on('command.run', async $ => ({text:JSON.stringify(await $.tool.check({tool:'Offline',input:{path:'file'}}))}));
  }`)
  const policy = await plugin('policy', `export function register(on) {
    on('tool.check', async ($,e,next) => {
      if(next.origin.plugin!=='caller'||e.tool_use_id!==undefined) throw Error('wrong origin');
      const verdict=await next(e); return {...verdict,reason:'policy '+verdict.reason};
    });
  }`)
  const inputs: unknown[] = []
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event),services:{
    toolHost: () => ({
      call: async () => { throw Error('must not execute') },
      check: async input => {inputs.push(input);return {decision:'ask',reason:'core'}},
    }),
  }})
  runtimes.push(runtime)
  await runtime.bind(binding)
  await runtime.reconcile([caller,policy])
  expect(diagnostics).toEqual([])
  expect(await runtime.dispatch('command.run',{},async () => ({}))).toEqual({text:JSON.stringify({decision:'ask',reason:'policy core'})})
  expect(inputs).toEqual([{tool:'Offline',input:{path:'file'}}])
  expect(diagnostics).toEqual([])
})

test('Worker author tools reach sibling middleware, executor, mapper and permission consumer with pinned identities', async () => {
  const caller = await plugin('caller',`let entries=0; export function register(on) {
    on('command.run',async $ => ({text:JSON.stringify({
      check:await $.tool.check({tool:'Offline',input:{value:'probe'}}),
      call:await $.tool.call({tool:'Offline',value:'run',agentId:'forged',tool_use_id:'forged'}),
      entries
    })}));
    on('tool.call',($,e,next) => {entries++;return next({...e,value:e.value+' sibling'})});
  }`)
  const policy = await plugin('policy',`export function register(on) {
    on('tool.call',($,e,next) => {
      if(next.origin.plugin!=='caller'||e.agentId!==undefined||e.tool_use_id==='forged') throw Error('bad call identity');
      return next({...e,value:e.value+' rewritten'});
    });
    on('tool.check',($,e,next) => {
      if(next.origin.plugin!=='caller') throw Error('bad check origin');
      return {decision:e.input.value==='probe'?'ask':'allow',reason:'policy'};
    });
  }`)
  const calls: unknown[] = []
  let dialogs = 0
  const tool = buildTool({
    name:'Offline',inputSchema:z.object({value:z.string()}),outputSchema:z.object({value:z.string()}),maxResultSizeChars:10000,
    description:async () => 'offline',prompt:async () => 'offline',isConcurrencySafe:() => true,
    checkPermissions:async () => ({behavior:'ask',message:'default ask'}),
    call:async input => {calls.push(input);return {data:input}},
    mapToolResultToToolResultBlockParam:(data,id) => ({type:'tool_result',tool_use_id:id,content:JSON.stringify(data)}),
    renderToolUseMessage:() => null,
  })
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event)})
  runtimes.push(runtime)
  const context = {
    mods:runtime,options:{tools:[tool],mcpClients:[],isNonInteractiveSession:true},
    messages:[],abortController:new AbortController(),getAppState:() => ({toolPermissionContext:getEmptyToolPermissionContext(),sessionHooks:new Map()}),
    setAppState:() => {},setInProgressToolUseIDs:() => {},
  } as unknown as ToolUseContext
  await runtime.bind(binding)
  await runtime.reconcile([caller,policy])
  expect(diagnostics).toEqual([])
  const snapshot = runtime.capture({toolHost:() => createModToolHost(context,async () => {dialogs++;return {behavior:'allow'}})})
  try {
    const result = await snapshot.dispatch('command.run',{},async () => ({})) as {text:string}
    expect(JSON.parse(result.text)).toEqual({check:{decision:'ask',reason:'policy'},call:{ref:1,result:{value:'run sibling rewritten'},text:'{"value":"run sibling rewritten"}'},entries:1})
    expect(calls).toEqual([{value:'run sibling rewritten'}])
    expect(dialogs).toBe(0)
    expect(diagnostics).toEqual([])
  } finally {snapshot.release()}
})

test('registered command consumers bind their current author tools and permission callback', async () => {
  const mod = await plugin('command-host',`export function register(on) {
    on('session.start',async ($,e,next)=>{await $.command.register({name:'probe',description:'Call a current tool'});return next(e)});
    on('command.run',{command:'probe'},async $=>({text:(await $.tool.call({tool:'Offline',value:'command'})).text}));
  }`)
  const calls: string[] = [], permissions: string[] = [], diagnostics: unknown[] = []
  const tool=buildTool({
    name:'Offline',inputSchema:z.object({value:z.string()}),maxResultSizeChars:1000,
    description:async()=>'offline',prompt:async()=>'offline',renderToolUseMessage:()=>null,
    call:async input=>{calls.push(input.value);return {data:'current:'+input.value}},
    mapToolResultToToolResultBlockParam:(data,id)=>({type:'tool_result',tool_use_id:id,content:data}),
  })
  const runtime=createModsRuntime({onDiagnostic:event=>diagnostics.push(event),services:{
    toolHost:()=>{throw Error('stale session tool host')},
  }})
  runtimes.push(runtime)
  await runtime.bind(binding)
  await runtime.reconcile([mod])
  const context={
    mods:runtime,options:{tools:[tool],mcpClients:[],isNonInteractiveSession:true},
    messages:[],abortController:new AbortController(),
    getAppState:()=>({toolPermissionContext:getEmptyToolPermissionContext(),sessionHooks:new Map()}),
    setAppState:()=>{},setInProgressToolUseIDs:()=>{},
    canUseTool:async()=>{permissions.push('current');return {behavior:'allow'}},
  } as unknown as import('../../types/command.js').LocalJSXCommandContext
  const command=runtime.commands.list().find(command=>command.name==='probe')!
  if(command.type!=='local-jsx') throw Error('Expected registered local command')
  const completed: (string|undefined)[]=[]
  await (await command.load()).call(text=>{completed.push(text)},context,'')
  expect(diagnostics).toEqual([])
  expect(completed).toEqual(['current:command'])
  expect(calls).toEqual(['command'])
  expect(permissions).toEqual(['current'])
})

test('author registration becomes callable and checkable within the same request without a context refresh', async () => {
  const caller=await plugin('live-register',`export function register(on) {
    on('command.run',async $=>{
      const registered=await $.tool.register({name:'echo',description:'Live registration',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']}});
      return {text:JSON.stringify({check:await $.tool.check({tool:registered.tool,input:{value:'probe'}}),call:await $.tool.call({tool:registered.tool,value:'called'})})};
    });
  }`)
  const implementation=await plugin('implementation',`export function register(on) {
    on('tool.call',{tool:'mcp__live-register__echo'},($,e)=>({result:e.value}));
  }`)
  const diagnostics: unknown[]=[]
  const runtime=createModsRuntime({onDiagnostic:event=>diagnostics.push(event)})
  runtimes.push(runtime)
  await runtime.bind(binding)
  await runtime.reconcile([caller,implementation])
  const context={
    mods:runtime,options:{tools:[],mcpClients:[],isNonInteractiveSession:true},
    messages:[],abortController:new AbortController(),
    getAppState:()=>({toolPermissionContext:{...getEmptyToolPermissionContext(),alwaysAskRules:{userSettings:['mcp__live-register__echo']}},sessionHooks:new Map()}),
    setAppState:()=>{},setInProgressToolUseIDs:()=>{},
  } as unknown as ToolUseContext
  const snapshot=runtime.capture({toolHost:()=>createModToolHost(context,async()=>({behavior:'allow'}))})
  try {
    const result=await snapshot.dispatch('command.run',{},async()=>({})) as {text:string}
    expect(diagnostics).toEqual([])
    expect(JSON.parse(result.text)).toMatchObject({check:{decision:'ask'},call:{result:'called'}})
    expect(runtime.tools.list().map(tool=>tool.name)).toEqual(['mcp__live-register__echo'])
    expect(context.options.tools).toEqual([])
  } finally {snapshot.release()}
})

test('author hosts do not execute retired dynamic tools retained in an older request context', async () => {
  const dynamic=await plugin('retired',`export function register(on) {
    on('session.start',async ($,e,next)=>{await $.tool.register({name:'echo',description:'Retirable'});return next(e)});
    on('tool.call',{tool:'mcp__retired__echo'},()=>({result:'old implementation'}));
  }`)
  const caller=await plugin('caller',`export function register(on) {
    on('command.run',async $=>{
      const errors=[];
      try{await $.tool.check({tool:'mcp__retired__echo',input:{}})}catch(error){errors.push(String(error))}
      try{await $.tool.call({tool:'mcp__retired__echo'})}catch(error){errors.push(String(error))}
      return {text:JSON.stringify(errors)};
    });
  }`)
  const diagnostics: unknown[]=[]
  const runtime=createModsRuntime({onDiagnostic:event=>diagnostics.push(event)})
  runtimes.push(runtime)
  await runtime.bind(binding)
  await runtime.reconcile([dynamic,caller])
  const context={
    mods:runtime,options:{tools:runtime.tools.projection([]),mcpClients:[],isNonInteractiveSession:true},
    messages:[],abortController:new AbortController(),
    getAppState:()=>({toolPermissionContext:getEmptyToolPermissionContext(),sessionHooks:new Map()}),
    setAppState:()=>{},setInProgressToolUseIDs:()=>{},
  } as unknown as ToolUseContext
  const host=createModToolHost(context,async()=>({behavior:'allow'}))
  await runtime.reconcile([caller])
  const snapshot=runtime.capture({toolHost:()=>host})
  try {
    const result=await snapshot.dispatch('command.run',{},async()=>({})) as {text:string}
    expect(JSON.parse(result.text)).toEqual([
      expect.stringContaining('No such tool available: mcp__retired__echo'),
      expect.stringContaining('No such tool available: mcp__retired__echo'),
    ])
    expect(host.tools()).toEqual([])
    expect(context.options.tools).toHaveLength(1)
    expect(diagnostics).toEqual([])
  } finally {snapshot.release()}
})

test('a registered tool with no answering hook fails through the real author executor', async () => {
  const dynamic = await plugin('unanswered',`export function register(on) {
    on('session.start',async ($,e,next) => {await $.tool.register({name:'echo',description:'No implementation'});return next(e)});
  }`)
  const caller = await plugin('caller',`export function register(on) {
    on('command.run',async $ => ({text:JSON.stringify(await $.tool.call({tool:'mcp__unanswered__echo'}))}));
  }`)
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic:event=>diagnostics.push(event)})
  runtimes.push(runtime)
  await runtime.bind(binding)
  await runtime.reconcile([dynamic,caller])
  const context = {
    mods:runtime,options:{tools:runtime.tools.projection([]),mcpClients:[],isNonInteractiveSession:true},
    messages:[],abortController:new AbortController(),
    getAppState:()=>({toolPermissionContext:getEmptyToolPermissionContext(),sessionHooks:new Map()}),
    setAppState:()=>{},setInProgressToolUseIDs:()=>{},
  } as unknown as ToolUseContext
  const snapshot = runtime.capture({toolHost:()=>createModToolHost(context,async()=>({behavior:'allow'}))})
  try {
    const result = await snapshot.dispatch('command.run',{},async()=>({})) as {text:string}
    expect(JSON.parse(result.text)).toMatchObject({ref:1,isError:true,text:expect.stringContaining('must be answered by a Mods tool.call hook')})
    expect(diagnostics).toEqual([])
  } finally {snapshot.release()}
})

test('Worker author cancellation reaches a running real tool without cancelling the session', async () => {
  const caller = await plugin('caller',`export function register(on) {
    on('command.run',async $ => ({text:JSON.stringify(await $.tool.call({tool:'Offline'}))}));
  }`)
  const entered = Promise.withResolvers<AbortSignal>()
  const tool = buildTool({
    name:'Offline',inputSchema:z.object({}),maxResultSizeChars:1000,
    description:async ()=>'offline',prompt:async ()=>'offline',renderToolUseMessage:()=>null,
    call:async (_input,context)=>{
      const signal=context.abortController.signal
      entered.resolve(signal)
      await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))
      return {data:'unreachable'}
    },
    mapToolResultToToolResultBlockParam:(data,id)=>({type:'tool_result',tool_use_id:id,content:data}),
  })
  const runtime = createModsRuntime()
  runtimes.push(runtime)
  const context = {
    mods:runtime,options:{tools:[tool],mcpClients:[],isNonInteractiveSession:true},
    messages:[],abortController:new AbortController(),
    getAppState:()=>({toolPermissionContext:getEmptyToolPermissionContext(),sessionHooks:new Map()}),
    setAppState:()=>{},setInProgressToolUseIDs:()=>{},
  } as unknown as ToolUseContext
  await runtime.bind(binding)
  await runtime.reconcile([caller])
  const snapshot = runtime.capture({toolHost:()=>createModToolHost(context,async()=>({behavior:'allow'}))})
  const controller = new AbortController()
  const failure = new Error('cancel real author call')
  const running = snapshot.dispatch('command.run',{},async()=>({}),{signal:controller.signal})
  const settled = running.then(()=>({ok:true as const}),error=>({ok:false as const,error}))
  try {
    const actual = await Promise.race([entered.promise,settled.then(()=>{throw Error('call did not reach tool')})])
    controller.abort(failure)
    expect(actual.aborted).toBe(true)
    expect((await settled).ok).toBe(false)
    expect(context.abortController.signal.aborted).toBe(false)
  } finally {controller.abort(failure);await settled;snapshot.release()}
})

test('request-local author hosts stay isolated and skip only the current registration', async () => {
  const caller = await plugin('caller', `export function register(on) {
    on('tool.call', async $ => ({result:await $.tool.call({tool:'Offline'})}));
    on('tool.call', ($,e,next) => next({...e,sibling:true}));
  }`)
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event)})
  runtimes.push(runtime)
  await runtime.reconcile([caller])
  const snapshots = ['first','second'].map(name => runtime.capture({toolHost:() => ({
    call:async (input, snapshot, signal) => {
      expect(snapshot.hasHooks('tool.call')).toBe(true)
      return snapshot.dispatch('tool.call',input,async e => ({result:{name,sibling:e.sibling}}),{
        signal,origin:{plugin:'forged',tier:'core'},caller:{plugin:'forged',registrationId:0},
      })
    },
    check:async () => ({decision:'allow' as const}),
  })}))
  try {
    const results = await Promise.all(snapshots.map(snapshot => snapshot.dispatch('tool.call',{},async () => ({result:'unexpected'}))))
    expect(results).toEqual(['first','second'].map(name => ({result:{result:{name,sibling:true}}})))
    expect(diagnostics).toEqual([])
  } finally {snapshots.forEach(snapshot => snapshot.release())}
})

test('recovered session.start retains completed tool registration and publishes its hook generation', async () => {
  const mod = await plugin('rollback',`export function register(on) {
    on('session.start',async ($,e,next) => {await $.tool.register({name:'echo',description:'previous'});return next(e)});
  }`)
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event)})
  runtimes.push(runtime)
  await runtime.bind(binding)
  await runtime.reconcile([mod])
  const previous = runtime.tools.list()[0]
  expect(previous).toBeDefined()
  await writeFile(mod.entrypoints[0]!,`export function register(on) {
    on('session.start',async ($,e,next) => {
      await $.tool.register({name:'echo',description:'candidate'});
      throw Error('start hook failed');
    });
    on('tool.call',{tool:'mcp__rollback__echo'},()=>({result:'candidate'}));
  }`)
  await runtime.reconcile([mod])
  expect(runtime.tools.list()).toHaveLength(1)
  expect(runtime.tools.list()[0]).not.toBe(previous)
  expect(await runtime.tools.list()[0]!.description({},{} as never)).toBe('candidate')
  expect(await runtime.dispatch('tool.call',{tool:'mcp__rollback__echo'},async()=>({result:'core'}))).toEqual({result:'candidate'})
  expect(diagnostics).toEqual([expect.objectContaining({stage:'session.start',message:'start hook failed'})])
})

test('standalone compaction consumers query author permissions from the current context', async () => {
  const mod=await plugin('compact-host',`export function register(on) {
    on('session.compact',async $=>({skip:(await $.tool.check({tool:'Offline',input:{value:'compact'}})).reason}));
  }`)
  let checked=0,compacted=0
  const diagnostics: unknown[]=[]
  const tool=buildTool({
    name:'Offline',inputSchema:z.object({value:z.string()}),maxResultSizeChars:1000,
    description:async()=>'offline',prompt:async()=>'offline',renderToolUseMessage:()=>null,
    checkPermissions:async()=>{checked++;return {behavior:'ask',message:'current compact probe'}},
    call:async()=>{throw Error('query must not execute')},
    mapToolResultToToolResultBlockParam:(_data,id)=>({type:'tool_result',tool_use_id:id,content:''}),
  })
  const runtime=createModsRuntime({onDiagnostic:event=>diagnostics.push(event),services:{
    toolHost:()=>{throw Error('stale session tool host')},
  }})
  runtimes.push(runtime)
  await runtime.bind(binding)
  await runtime.reconcile([mod])
  const context={
    mods:runtime,options:{tools:[tool],mcpClients:[],isNonInteractiveSession:true,agentDefinitions:{activeAgents:[]}},
    messages:[],abortController:new AbortController(),
    getAppState:()=>({toolPermissionContext:getEmptyToolPermissionContext(),sessionHooks:new Map()}),
    setAppState:()=>{},setInProgressToolUseIDs:()=>{},
  } as unknown as ToolUseContext
  const result=await runModSessionCompact(context,'manual',[],undefined,async()=>{
    compacted++;throw Error('compaction should be skipped')
  },async()=>{throw Error('check must not prompt')}).then(value=>value,error=>error)
  expect(diagnostics).toEqual([])
  expect(result).toEqual({skip:'current compact probe'})
  expect(checked).toBe(1)
  expect(compacted).toBe(0)
})

test('standalone compaction author calls use current tools and supplied permissions', async () => {
  const mod=await plugin('compact-call',`export function register(on) {
    on('session.compact',async $=>{
      const tools=await $.tool.list();
      const result=await $.tool.call({tool:'Offline',value:'compact'});
      return {skip:tools.map(tool=>tool.name).join(',')+':'+result.text};
    });
  }`)
  const calls: string[]=[], permissions: string[]=[], diagnostics: unknown[]=[]
  const tool=buildTool({
    name:'Offline',inputSchema:z.object({value:z.string()}),maxResultSizeChars:1000,
    description:async()=>'offline',prompt:async()=>'offline',renderToolUseMessage:()=>null,
    call:async input=>{calls.push(input.value);return {data:'current compact result'}},
    mapToolResultToToolResultBlockParam:(data,id)=>({type:'tool_result',tool_use_id:id,content:data}),
  })
  const runtime=createModsRuntime({onDiagnostic:event=>diagnostics.push(event),services:{
    toolHost:()=>{throw Error('stale session tool host')},
    toolCatalog:()=>{throw Error('stale session tool catalog')},
  }})
  runtimes.push(runtime)
  await runtime.bind(binding)
  await runtime.reconcile([mod])
  const context={
    mods:runtime,options:{tools:[tool],mcpClients:[],isNonInteractiveSession:true,agentDefinitions:{activeAgents:[]}},
    messages:[],abortController:new AbortController(),
    getAppState:()=>({toolPermissionContext:getEmptyToolPermissionContext(),sessionHooks:new Map()}),
    setAppState:()=>{},setInProgressToolUseIDs:()=>{},
  } as unknown as ToolUseContext
  const result=await runModSessionCompact(context,'manual',[],undefined,async()=>{
    throw Error('compaction should be skipped')
  },async tool=>{permissions.push(tool.name);return {behavior:'allow'}}).then(value=>value,error=>error)
  expect(diagnostics).toEqual([])
  expect(result).toEqual({skip:'Offline:current compact result'})
  expect(calls).toEqual(['compact'])
  expect(permissions).toEqual(['Offline'])
})

for (const borrowed of [false,true]) {
  for (const outcome of ['success','skip','dispatch failure','invalid result','projection failure','abort'] as const) {
    test(`compaction ${borrowed ? 'borrowed' : 'owned'} snapshot ownership on ${outcome}`, async () => {
      let captures=0,releases=0
      const failure=new Error(outcome)
      const snapshot={
        hasHooks:()=>true,
        release:()=>{releases++},
        dispatch:async()=>{
          if(outcome==='dispatch failure') throw failure
          if(outcome==='abort') context.abortController.abort(failure)
          if(outcome==='invalid result') return {messages:[]}
          if(outcome==='skip') return {skip:'skip'}
          return {messages:[{role:'user',text:'compacted',toolUses:[]}]}
        },
      }
      const context={
        abortController:new AbortController(),
        ...(borrowed ? {modsSnapshot:snapshot} : {}),
        mods:{hasHooks:()=>true,capture:()=>{captures++;return snapshot}},
      } as unknown as ToolUseContext
      const messages=outcome==='projection failure'
        ? [Object.defineProperty({type:'assistant'},'message',{get(){throw failure}})] as any
        : []
      const pending=runModSessionCompact(context,'manual',messages,undefined,async()=>{
        throw Error('unexpected core')
      },async()=>({behavior:'allow'}))
      if(outcome==='dispatch failure' || outcome==='projection failure' || outcome==='abort') await expect(pending).rejects.toBe(failure)
      else if(outcome==='invalid result') await expect(pending).rejects.toThrow('nonempty messages')
      else if(outcome==='skip') expect(await pending).toEqual({skip:'skip'})
      else expect((await pending).compactionResult?.messagesToKeep).toHaveLength(1)
      expect(captures).toBe(borrowed ? 0 : 1)
      expect(releases).toBe(borrowed ? 0 : 1)
    })
  }
}
