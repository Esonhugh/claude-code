import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime, type ModsRuntime } from './runtime.js'

const roots: string[] = []
const runtimes: ModsRuntime[] = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function plugin(name: string, source: string) {
  const pluginRoot = await mkdtemp(join(tmpdir(), 'mods-agents-'))
  roots.push(pluginRoot)
  const entry = join(pluginRoot, 'register.ts')
  await writeFile(entry, source)
  return { name, storageId: name + '@test', pluginRoot, entrypoints: [entry] }
}
const binding = { cwd: '/tmp', surface: null, isInteractive: false, sessionId: 'offline' } as const

test('production Worker agent.register is hookable and replaces its real definition', async () => {
  const mod = await plugin('author', `export function register(on) {
    let version = 0;
    on('command.run', async $ => {
      try { return {text:JSON.stringify(await $.agent.register({name:'reviewer',description:'Review '+(++version),prompt:'Original'}))}; }
      catch { return {text:'retired'}; }
    });
  }`)
  const policy = await plugin('policy', `export function register(on) {
    on('agent.register', ($,e,next) => next({...e,prompt:e.prompt+' rewritten'}));
  }`)
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic: event => diagnostics.push(event)})
  runtimes.push(runtime)
  await runtime.bind(binding)
  await runtime.reconcile([mod, policy])
  expect(diagnostics).toEqual([])
  const snapshot = runtime.capture()
  try {
    expect(await snapshot.dispatch('command.run', {}, async () => ({}))).toEqual({text:'{"agent":"author:reviewer"}'})
    expect(await snapshot.dispatch('command.run', {}, async () => ({}))).toEqual({text:'{"agent":"author:reviewer"}'})
    const definitions = runtime.agents.getSnapshot()
    expect(definitions).toHaveLength(1)
    expect(definitions[0]?.agentType).toBe('author:reviewer')
    expect(definitions[0]?.whenToUse).toBe('Review 2')
    const definition = definitions[0]!
    if (definition.source === 'built-in') throw new Error('Expected a registered plugin agent')
    expect(definition.getSystemPrompt()).toBe('Original rewritten')
    await runtime.reconcile([])
    expect(runtime.agents.getSnapshot()).toEqual([])
    expect(await snapshot.dispatch('command.run', {}, async () => ({}))).toEqual({text:'retired'})
    expect(runtime.agents.getSnapshot()).toEqual([])
  } finally { snapshot.release() }
})

test('production Worker stages reload definitions atomically and preserves the old definition on failed startup', async () => {
  const source = (version: string, fail = false) => `export function register(on) {
    on('session.start', async ($,e,next) => {
      await $.agent.register({name:'reviewer',description:'${version}',prompt:'${version}',tools:['Read'],maxTurns:3});
      ${fail ? "throw Error('failed startup');" : 'return next(e);'}
    });
    on('command.run', async $ => {
      try { await $.agent.register({name:'reviewer',description:'invalid',prompt:'invalid',maxTurns:0}); }
      catch { return {text:'rejected'}; }
      return {text:'accepted'};
    });
  }`
  const mod = await plugin('reload', source('old'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event)})
  runtimes.push(runtime)
  await runtime.bind(binding)
  await runtime.reconcile([mod])
  expect(diagnostics).toEqual([])
  const old = runtime.agents.getSnapshot()[0]!
  const seen: string[][] = []
  const unsubscribe = runtime.agents.subscribe(() => seen.push(runtime.agents.getSnapshot().map(agent => agent.whenToUse)))
  const snapshot = runtime.capture()
  try {
    expect(await snapshot.dispatch('command.run',{},async()=>({}))).toEqual({text:'rejected'})
    expect(runtime.agents.getSnapshot()[0]).toBe(old)
    await writeFile(mod.entrypoints[0]!, source('failed', true))
    await runtime.reconcile([mod])
    expect(runtime.agents.getSnapshot()[0]).toBe(old)
    expect(seen).toEqual([])
    expect(diagnostics).toContainEqual(expect.objectContaining({plugin:'reload',stage:'session.start',message:'failed startup'}))
    await writeFile(mod.entrypoints[0]!, source('new'))
    await runtime.reconcile([mod])
    expect(seen).toEqual([['new']])
    expect(runtime.agents.getSnapshot()[0]).toMatchObject({agentType:'reload:reviewer',tools:['Read'],maxTurns:3})
    const projected = runtime.agents.projection({activeAgents:[old],allAgents:[old]})
    expect(projected.activeAgents).toEqual(runtime.agents.getSnapshot())
    await runtime.reconcile([])
    expect(runtime.agents.projection(projected)).toEqual({activeAgents:[],allAgents:[]})
  } finally { snapshot.release(); unsubscribe() }
})

test('production Worker agent.spawn skips only its calling hook and starts through the host', async () => {
  const caller = await plugin('caller', `export function register(on) {
    on('*', async ($,e,next) => {
      if (next.event === 'agent.spawn') return {deny:'caller recursed'};
      if (next.event === 'command.run') return {text:JSON.stringify(await $.agent.spawn({prompt:'review',description:'Review',subagentType:'reviewer',model:'haiku',name:'worker',cwd:'/tmp/work'}))};
      return next(e);
    });
  }`)
  const policy = await plugin('policy', `export function register(on) {
    on('agent.spawn', ($,e,next) => next({...e,prompt:e.prompt+' rewritten'}));
  }`)
  const calls: unknown[] = []
  const runtime = createModsRuntime({services:{agentSpawn:async (request, spawnSnapshot, signal) =>
    spawnSnapshot.dispatch('agent.spawn', {
      tool_use_id:'mod-spawn',
      description:'Agent task',
      subagentType:'general-purpose',
      provider:{plugin:'engine',tier:'core'},
      parentModel:'claude-sonnet',
      background:true,
      fork:false,
      ...request,
    }, async rewritten => {
      calls.push({request:rewritten,signal})
      return {model:'claude-haiku',agentId:'agent-child'}
    }, {signal}) as Promise<{model:string;agentId?:string}|{deny:string}>
  }})
  runtimes.push(runtime)
  await runtime.bind(binding)
  await runtime.reconcile([caller,policy])
  const snapshot = runtime.capture()
  try {
    expect(await snapshot.dispatch('command.run',{},async()=>({}))).toEqual({text:'{"model":"claude-haiku","agentId":"agent-child"}'})
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({request:{prompt:'review rewritten',description:'Review',subagentType:'reviewer',model:'haiku',name:'worker',cwd:'/tmp/work'}})
  } finally { snapshot.release() }
})

test('production Worker agent.list reads live session tasks rather than definitions', async () => {
  const mod = await plugin('observer', `export function register(on) {
    on('command.run', async $ => ({text:JSON.stringify(await $.agent.list())}));
  }`)
  let tasks: Record<string, unknown> = {
    child: {id:'child',type:'local_agent',description:'Review changes',status:'running',agentId:'agent-child',agentType:'Explore',parentAgentId:'parent',spawnedBy:'author'},
    mate: {id:'mate',type:'in_process_teammate',description:'Help',status:'running',identity:{agentId:'agent-mate',agentName:'reviewer',agentType:'general-purpose'}},
    shell: {id:'shell',type:'local_bash',description:'Ignored',status:'running'},
  }
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event),services:{tasks:() => tasks as import('../../state/AppState.js').AppState['tasks'],agentNames:()=>new Map([['child-name','agent-child' as never]])}})
  runtimes.push(runtime)
  await runtime.bind(binding)
  await runtime.reconcile([mod])
  expect(diagnostics).toEqual([])
  const snapshot = runtime.capture()
  try {
    const list = async () => JSON.parse((await snapshot.dispatch('command.run',{},async()=>({})) as {text:string}).text)
    expect(await list()).toEqual([
      {id:'agent-child',description:'Review changes',type:'Explore',status:'running',parentId:'parent',spawnedBy:'author',name:'child-name'},
      {id:'agent-mate',description:'Help',type:'teammate',status:'running',name:'reviewer'},
    ])
    tasks = {}
    expect(await list()).toEqual([])
  } finally { snapshot.release() }
})
