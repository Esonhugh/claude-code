import { z } from 'zod/v4'
import { buildTool, type ToolUseContext } from '../../Tool.js'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { resetSettingsCache, setCachedSettingsForSource, setSessionSettingsCache } from '../../utils/settings/settingsCache.js'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime, type ModsRuntime } from './runtime.js'
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
