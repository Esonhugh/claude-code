import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createModsRuntime } from './runtime.js'
import { loadModDeclaration } from './loader.js'
import builtinDiff from '../../commands/diff/index.js'
import type { Command } from '../../types/command.js'
import type { Tool } from '../../Tool.js'
import { createToolCatalog, describeModTool } from './toolCatalog.js'
import { resetSettingsCache, setCachedSettingsForSource, setSessionSettingsCache } from '../../utils/settings/settingsCache.js'

let root: string
const runtimes: ReturnType<typeof createModsRuntime>[] = []
const envKeys = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_CACHE_DIR', 'CLAUDE_CODE_USE_COWORK_PLUGINS']
let saved: (string | undefined)[]
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mods-runtime-host-'))
  saved = envKeys.map(key => process.env[key])
  process.env.HOME = root
  process.env.USERPROFILE = root
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = join(root, 'config', 'plugins')
  delete process.env.CLAUDE_CODE_USE_COWORK_PLUGINS
  resetSettingsCache()
})
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
  resetSettingsCache()
  envKeys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i] })
  await rm(root, { recursive: true, force: true })
})
async function plugin(name: string, source: string) {
  const pluginRoot = join(root, name)
  await mkdir(pluginRoot)
  const entry = join(pluginRoot, 'register.ts')
  await writeFile(entry, source)
  return { name, storageId: name + '@test', pluginRoot, entrypoints: [entry] }
}
function runtime(messages: () => unknown[] = () => []) {
  const diagnostics: unknown[] = []
  const value = createModsRuntime({ onDiagnostic: event => diagnostics.push(event), services: { messages } })
  runtimes.push(value)
  return { value, diagnostics }
}
function tool(name: string): Tool {
  return { name } as Tool
}
test('Worker tool.list uses each captured request catalog without crossing concurrent requests or reloads', async () => {
  const consumer = await plugin('catalog-consumer', `export function register(on) {
    on('tool.call', async ($) => ({result:await $.tool.list()}));
  }`)
  const { value, diagnostics } = runtime()
  await value.bind(binding(root))
  await value.reconcile([consumer])
  const firstTools = [tool('first')]
  let secondTools = [tool('second')]
  const firstCatalog = [{name:'first',description:'First catalog',mcp:false}]
  const secondCatalog = [{name:'second',description:'Second catalog',mcp:false}]
  const refreshedCatalog = [{name:'refreshed',description:'Refreshed catalog',mcp:false}]
  const descriptions = new Map([['first', 'First catalog'], ['second', 'Second catalog'], ['refreshed', 'Refreshed catalog']])
  let reads = 0
  const first = value.capture({toolCatalog:() => createToolCatalog(firstTools, async tool => {
    reads++
    await delay(15)
    return descriptions.get(tool.name)!
  })})
  const second = value.capture({toolCatalog:() => createToolCatalog(secondTools, async tool => descriptions.get(tool.name)!)})
  try {
    const core = async () => ({result:'unexpected core'})
    expect(await Promise.all([
      first.dispatch('tool.call', {tool:'Read'}, core),
      second.dispatch('tool.call', {tool:'Read'}, core),
    ])).toEqual([{result:firstCatalog},{result:secondCatalog}])
    secondTools = [tool('refreshed')]
    expect(await second.dispatch('tool.call', {tool:'Read'}, core)).toEqual({result:refreshedCatalog})
    await value.reconcile([])
    expect(await first.dispatch('tool.call', {tool:'Read'}, core)).toEqual({result:firstCatalog})
    expect(reads).toBe(2)
    expect(diagnostics).toEqual([])
  } finally {
    first.release()
    second.release()
  }
  await expect(first.dispatch('tool.call', {tool:'Read'}, async () => ({}))).rejects.toThrow('snapshot released')
})

test('tool.list has no fabricated empty catalog and respects host binding and noun withholding', async () => {
  const consumer = await plugin('catalog-access', `export function register(on) {
    on('tool.call', async ($) => {
      try { return {result:await $.tool.list()}; }
      catch (error) { return {result:{error:error.message}}; }
    });
  }`)
  const hidden = await plugin('catalog-policy', `export function register(on) {
    on('engine.create', async ($, e, next) => { const built = await next(e); return {}; });
  }`)
  const {value, diagnostics} = runtime()
  await value.bind(binding(root))
  await value.reconcile([consumer])
  const dispatch = () => value.dispatch('tool.call', {tool:'Read'}, async () => ({result:'unexpected'}))
  expect(await dispatch()).toEqual({result:{error:'Tool catalog is unavailable on this host'}})
  await value.reconcile([hidden, consumer])
  expect(diagnostics).toEqual([])
  const held = value.capture({toolCatalog:() => createToolCatalog([{name:'forbidden'}] as Tool[], async () => 'Not visible')})
  try {
    expect(await held.dispatch('tool.call', {tool:'Read'}, async () => ({result:'unexpected'}))).toEqual({
      result:{error:'Module capability tool.list was withheld by catalog-policy'},
    })
  } finally { held.release() }
  expect(diagnostics).toEqual([])
  const host = createModsRuntime({services:{toolCatalog:() => createToolCatalog([{name:'host'}] as Tool[], async () => 'Host catalog')}})
  runtimes.push(host)
  await host.bind(binding(root))
  await host.reconcile([consumer])
  expect(await host.dispatch('tool.call', {tool:'Read'}, async () => ({result:'unexpected'}))).toEqual({
    result:[{name:'host',description:'Host catalog',mcp:false}],
  })
})

test('author tool.list middleware cannot invent executable identities outside its captured catalog', async () => {
  const rewrite = await plugin('invent-tool', `export function register(on) {
    on('tool.list', () => ({value:[{name:'not-admitted',description:'Forged tool',mcp:false}]}));
  }`)
  const consumer = await plugin('list-tools', `export function register(on) {
    on('tool.call', async ($) => ({result:await $.tool.list()}));
  }`)
  const {value, diagnostics} = runtime()
  await value.bind(binding(root))
  await value.reconcile([rewrite, consumer])
  const snapshot = value.capture({toolCatalog:() => createToolCatalog([{name:'Read'}] as Tool[], async () => 'Read files')})
  try {
    const result = await snapshot.dispatch('tool.call', {tool:'Read'}, async () => ({result:'unexpected'}))
    expect(result).toEqual({result:[{name:'Read',description:'Read files',mcp:false}]})
    expect(diagnostics).toEqual([expect.objectContaining({plugin:'invent-tool',stage:'tool.list',message:expect.stringContaining('unknown or gated tool not-admitted')})])
  } finally { snapshot.release() }
})

test('tool description caches are generation-scoped and explicit invalidation refreshes live captures', async () => {
  const consumer = await plugin('descriptions', `let reads=0; export function register(on) {
    on('tool.describe', ($, e) => ({description:e.description+':'+(++reads)}));
    on('tool.call', async ($) => { await $.ui.invalidate('tool.describe'); return {result:'invalidated'}; });
  }`)
  const {value, diagnostics} = runtime()
  await value.bind(binding(root))
  await value.reconcile([consumer])
  const tool = {name:'Read'} as Tool
  const first = value.capture()
  const sibling = value.capture()
  try {
    expect(await describeModTool(first, tool, 'base')).toBe('base:1')
    expect(await describeModTool(sibling, tool, 'base')).toBe('base:1')
    expect(await first.dispatch('tool.call', {tool:'Read'}, async () => ({result:'unexpected'}))).toEqual({result:'invalidated'})
    expect(await describeModTool(sibling, tool, 'base')).toBe('base:2')
    await value.reconcile([{...consumer,options:{generation:2}}])
    const next = value.capture()
    try {
      expect(await describeModTool(next, tool, 'base')).toBe('base:1')
      expect(await describeModTool(first, tool, 'base')).toBe('base:2')
    } finally { next.release() }
    expect(diagnostics).toEqual([])
  } finally {
    first.release()
    sibling.release()
  }
})

test('session.start reads the host catalog while projected commands use their caller catalog', async () => {
  const consumer = await plugin('catalog-command', `let initial; export function register(on) {
    on('session.start', async ($, e, next) => {
      initial=await $.tool.list();
      await $.command.register({name:'catalog',description:'Catalog',immediate:true});
      return next(e);
    });
    on('command.run', {command:'catalog'}, async ($) => ({text:JSON.stringify({initial,current:await $.tool.list()})}));
  }`)
  const diagnostics: unknown[] = []
  const value = createModsRuntime({services:{toolCatalog:()=>createToolCatalog([tool('HostTool')],async()=> 'Host description')},onDiagnostic:event=>diagnostics.push(event)})
  runtimes.push(value)
  await value.bind(binding(root))
  await value.reconcile([consumer])
  const command = value.commands.list()[0]!
  expect(command.type).toBe('local-jsx')
  if (command.type !== 'local-jsx') throw Error('Expected JSX command')
  const callerTool = {name:'CallerTool',inputJSONSchema:{type:'object',properties:{}},prompt:async()=> 'Caller description'} as unknown as Tool
  const context = {
    abortController:new AbortController(),
    options:{tools:[callerTool],mainLoopModel:'claude-sonnet-4-6',agentDefinitions:{activeAgents:[],allAgents:[]}},
    getAppState:()=>({toolPermissionContext:{}}),
  } as any
  const results: unknown[] = []
  await (await command.load()).call(text=>results.push(JSON.parse(text!)),context,'')
  expect(results).toEqual([{initial:[{name:'HostTool',description:'Host description',mcp:false}],current:[{name:'CallerTool',description:'Caller description',mcp:false}]}])
  expect(diagnostics).toEqual([])
})

test('commands become visible after start, dispatch once, and retire with their activation', async () => {
  const consumer = await plugin('command', `let calls=0; export function register(on) {
    on('session.start', async ($, e, next) => { await $.command.register({name:'panel', description:'Panel', immediate:true}); return next(e); });
    on('command.run', {command:'panel'}, ($, e) => ({text:e.args + ':' + (++calls)}));
  }`)
  const { value, diagnostics } = runtime()
  await value.reconcile([consumer])
  expect(value.commands.list()).toEqual([])
  await value.bind(binding(root))
  expect(diagnostics).toEqual([])
  const command = value.commands.list()[0]!
  expect(command).toMatchObject({name:'panel', type:'local-jsx', immediate:true})
  if (command.type !== 'local-jsx') throw Error('Expected JSX command')
  const completions: unknown[] = []
  const module = await command.load()
  await module.call(text => { completions.push(text) }, {abortController:new AbortController()} as any, 'argument')
  expect(completions).toEqual(['argument:1'])
  await value.reconcile([])
  expect(value.commands.list()).toEqual([])
})

test('a projected command preserves actual ingress metadata and dispatches only once through slash processing', async () => {
  const consumer = await plugin('command-metadata', `let calls=0; export function register(on) {
    on('session.start', async ($, e, next) => { await $.command.register({name:'panel', description:'Panel'}); return next(e); });
    on('command.run', {command:'panel'}, ($, e) => ({text:JSON.stringify({origin:e.origin, presentation:e.presentation, calls:++calls})}));
  }`)
  const { value, diagnostics } = runtime()
  await value.bind(binding(root))
  await value.reconcile([consumer])
  const {processSlashCommand} = await import('../../utils/processUserInput/processSlashCommand.js')
  const result = await processSlashCommand('/panel', [], [], [], {
    abortController:new AbortController(), mods:value,
    modCommand:{origin:{kind:'sdk'}, presentation:{columns:96, isFullscreen:false}},
    options:{commands:value.commands.list(), isNonInteractiveSession:false},
  } as any, () => {})
  expect(JSON.parse(result.resultText!)).toEqual({origin:{kind:'sdk'}, presentation:{columns:96, isFullscreen:false}, calls:1})
  expect(diagnostics).toEqual([])
})

test('Worker command.list reports public source names, display names and the current registering plugin', async () => {
  const locals: Command[] = [
    {name:'internal',userFacingName:()=>'public-name',description:'Built in',type:'local-jsx',load:async()=>({call:async()=>null}),immediate:true},
    {name:'server-local',description:'MCP local',type:'local-jsx',loadedFrom:'mcp',load:async()=>({call:async()=>null})},
  ]
  const prompts: Command[] = (['builtin','bundled','mcp','plugin','userSettings','projectSettings','localSettings','flagSettings','policySettings'] as const).map(source => ({
    name:`prompt-${source}`,description:source,type:'prompt',source,progressMessage:'',contentLength:0,getPromptForCommand:async()=>[],
    ...(source==='plugin'?{pluginInfo:{pluginManifest:{name:'markdown-owner'},repository:'fixture'}}:{}),
  }))
  const first = await plugin('first-owner', `export function register(on) {
    on('session.start', async ($, e, next) => { await $.command.register({name:'shared',description:'First'}); return next(e); });
  }`)
  const replacement = await plugin('second-owner', `export function register(on) {
    on('session.start', async ($, e, next) => { await $.command.register({name:'shared',description:'Second'}); return next(e); });
  }`)
  const observer = await plugin('listing', `export function register(on) {
    on('tool.call', async ($) => ({result:await $.command.list()}));
  }`)
  const diagnostics: unknown[] = []
  const value = createModsRuntime({services:{commands:()=>[...locals,...prompts]},onDiagnostic:event=>diagnostics.push(event)})
  runtimes.push(value)
  await value.bind(binding(root))
  const expected = [
    {name:'public-name',description:'Built in',source:'builtin'},
    {name:'server-local',description:'MCP local',source:'mcp'},
    ...prompts.map(command=>({name:command.name,description:command.description,source:command.description==='bundled'?'builtin':command.description.endsWith('Settings')?'user':command.description,...(command.description==='plugin'?{plugin:'markdown-owner'}:{})})),
  ]
  await value.reconcile([first,observer])
  expect(await value.dispatch('tool.call', input, async()=>({result:'unexpected core'}))).toEqual({result:[
    ...expected,{name:'shared',description:'First',source:'plugin',plugin:'first-owner'},
  ]})
  await value.reconcile([observer])
  expect(await value.dispatch('tool.call', input, async()=>({result:'unexpected core'}))).toEqual({result:expected})
  await value.reconcile([replacement,observer])
  expect(await value.dispatch('tool.call', input, async()=>({result:'unexpected core'}))).toEqual({result:[
    ...expected,{name:'shared',description:'Second',source:'plugin',plugin:'second-owner'},
  ]})
  expect(diagnostics).toEqual([])
})

test('Worker command.register rejects whitespace descriptions and preserves multiline text', async () => {
  const consumer = await plugin('command-description', `export function register(on) {
    on('session.start', async ($, e, next) => {
      let rejected=0;
      for (const description of ['', ' ', '\\t', '\\r\\n']) {
        try { await $.command.register({name:'invalid',description}); } catch { rejected++; }
      }
      if(rejected!==4) throw Error('invalid descriptions accepted');
      await $.command.register({name:'valid',description:'First line\\nSecond line'});
      return next(e);
    });
  }`)
  const {value, diagnostics} = runtime()
  await value.bind(binding(root))
  await value.reconcile([consumer])
  expect(value.commands.list().map(command => ({name:command.name,description:command.description}))).toEqual([
    {name:'valid',description:'First line\nSecond line'},
  ])
  expect(diagnostics).toEqual([])
})

test('Worker store calls reject empty and oversized keys without retiring the activation', async () => {
  const consumer = await plugin('store-keys', `export function register(on) {
    on('tool.call', async ($) => {
      await $.store.set('original', 'kept');
      let rejected=0;
      for (const key of ['', 'a'.repeat(257)]) {
        try { await $.store.get(key); } catch { rejected++; }
        try { await $.store.set(key, 'invalid'); } catch { rejected++; }
        try { await $.store.delete(key); } catch { rejected++; }
      }
      const longest='a'.repeat(256);
      await $.store.set(longest, 'valid');
      const value=await $.store.get(longest);
      await $.store.delete(longest);
      return {result:{rejected,value,keys:await $.store.keys(),original:await $.store.get('original')}};
    });
  }`)
  const { value, diagnostics } = runtime()
  await value.bind(binding(root))
  await value.reconcile([consumer])
  let coreCalls = 0
  for (let call = 0; call < 2; call++) {
    expect(await value.dispatch('tool.call', input, async () => {
      coreCalls++
      return { result: 'unexpected core' }
    })).toEqual({ result: { rejected: 6, value: 'valid', keys: ['original'], original: 'kept' } })
  }
  expect(coreCalls).toBe(0)
  expect(diagnostics).toEqual([])
})

test('Worker rejects empty store keys before middleware but checks oversized keys at the host', async () => {
  const observer = await plugin('store-observer', `export function register(on) {
    const calls=[];
    on('store.get', ($, e, next) => { calls.push(['store.get',e.key.length]); return next(e); });
    on('store.set', ($, e, next) => { calls.push(['store.set',e.key.length]); return next(e); });
    on('store.delete', ($, e, next) => { calls.push(['store.delete',e.key.length]); return next(e); });
    on('tool.call', async ($, e, next) => { const value=await next(e); return {result:{...value.result,calls}}; });
  }`)
  const consumer = await plugin('store-keys', `export function register(on) {
    on('tool.call', async ($) => {
      let rejected=0;
      for (const key of ['', 'a'.repeat(257)]) {
        try { await $.store.get(key); } catch { rejected++; }
        try { await $.store.set(key, 1); } catch { rejected++; }
        try { await $.store.delete(key); } catch { rejected++; }
      }
      return {result:{rejected}};
    });
  }`)
  const { value, diagnostics } = runtime()
  await value.bind(binding(root))
  await value.reconcile([observer, consumer])
  expect(await value.dispatch('tool.call', input, async () => ({result:'unexpected core'}))).toEqual({
    result: {rejected:6,calls:[['store.get',257],['store.set',257],['store.delete',257]]},
  })
  expect(diagnostics).toEqual(['store.get', 'store.set', 'store.delete'].map(stage => ({
    plugin: 'store-observer', stage, message: 'key must be a nonempty string of at most 256 characters',
  })))
})

test('Worker store.set normalizes JSON in the author realm before crossing the host bridge', async () => {
  const observer = await plugin('store-observer', `export function register(on) {
    let writes=0;
    on('store.set', ($, e, next) => { writes++; return next(e); });
    on('tool.call', async ($, e, next) => { const value=await next(e); return {result:{...value.result,writes}}; });
  }`)
  const consumer = await plugin('store-json', `export function register(on) {
    let conversions=0;
    on('tool.call', async ($) => {
      const value = {date:new Date('2026-01-01T00:00:00Z'), missing:undefined, omitted:()=>1, array:[undefined,()=>1], map:new Map(), set:new Set(), custom:{toJSON(){conversions++;return 'converted';}}};
      await $.store.set('json', value);
      const cycle={}; cycle.self=cycle;
      let rejected=0;
      for(const invalid of [undefined, () => 1, cycle, BigInt(1)]) {
        try { await $.store.set('json', invalid); } catch { rejected++; }
      }
      return {result:{stored:await $.store.get('json'), conversions, rejected}};
    });
  }`)
  const { value, diagnostics } = runtime()
  await value.bind(binding(root))
  await value.reconcile([observer, consumer])
  expect(await value.dispatch('tool.call', input, async () => ({result:'unexpected core'}))).toEqual({
    result: {
      stored: { date: '2026-01-01T00:00:00.000Z', array: [null, null], map: {}, set: {}, custom: 'converted' },
      writes: 1, conversions: 1, rejected: 4,
    },
  })
  expect(diagnostics).toEqual([])
})

test('Worker store preserves multibyte values at the official character limit and recovers after overflow', async () => {
  const consumer = await plugin('store-limit', `export function register(on) {
    on('tool.call', async ($) => {
      const limit=4194304;
      const length=limit-JSON.stringify({big:''}).length;
      const original='界'.repeat(length);
      await $.store.set('big', original);
      const stored=await $.store.get('big');
      let rejected=0;
      try { await $.store.set('another', 1); } catch { rejected++; }
      try { await $.store.set('big', original+'界'); } catch { rejected++; }
      const unchanged=await $.store.get('big')===original;
      await $.store.delete('big');
      await $.store.set('recovered', true);
      return {result:{length:stored.length,expected:length,unchanged,rejected,recovered:await $.store.get('recovered')}};
    });
  }`)
  const { value, diagnostics } = runtime()
  await value.bind(binding(root))
  await value.reconcile([consumer])
  const length = 4194304 - JSON.stringify({big: ''}).length
  expect(await value.dispatch('tool.call', input, async () => ({result:'unexpected core'}))).toEqual({
    result:{length,expected:length,unchanged:true,rejected:2,recovered:true},
  })
  expect(diagnostics).toEqual([])
}, 15000)

test('failed start discards registered commands and hooks before publication', async () => {
  const consumer = await plugin('failed-start', `export function register(on) {
    on('session.start', async ($, e, next) => { await $.command.register({name:'broken', description:'Broken'}); throw Error('start failed'); });
    on('tool.call', () => ({result:'broken'}));
  }`)
  const { value, diagnostics } = runtime()
  await value.reconcile([consumer])
  await value.bind(binding(root))
  expect(value.commands.list()).toEqual([])
  expect(await value.dispatch('tool.call', input, async () => ({result:'core'}))).toEqual({result:'core'})
  expect(diagnostics).toContainEqual(expect.objectContaining({plugin:'failed-start', stage:'session.start', message:'start failed'}))
})

test('failed replacement start preserves the old command and callable generation', async () => {
  const source = (label: string, fail: boolean) => `export function register(on) {
    on('session.start', async ($, e, next) => { await $.command.register({name:'panel', description:'${label}'}); ${fail ? "throw Error('replacement failed');" : 'return next(e);'} });
    on('command.run', () => ({text:'${label}'}));
    on('tool.call', () => ({result:'${label}'}));
  }`
  const consumer = await plugin('replacement', source('old', false))
  const { value, diagnostics } = runtime()
  await value.bind(binding(root))
  await value.reconcile([consumer])
  const old = value.commands.list()[0]!
  const notifications: string[][] = []
  value.commands.subscribe(() => notifications.push(value.commands.list().map(command => command.description)))
  await writeFile(consumer.entrypoints[0]!, source('failed', true))
  await value.reconcile([consumer])
  expect(value.commands.list()[0]).toBe(old)
  expect(notifications).toEqual([])
  expect(await value.dispatch('tool.call', input, async () => ({result:'core'}))).toEqual({result:'old'})
  expect(diagnostics).toContainEqual(expect.objectContaining({stage:'session.start', message:'replacement failed'}))
  if (old.type !== 'local-jsx') throw Error('Expected JSX command')
  const result: unknown[] = []
  await (await old.load()).call(text => result.push(text), {abortController:new AbortController()} as any, '')
  expect(result).toEqual(['old'])
})

test('successful replacement publishes one command snapshot with the new hook generation', async () => {
  const source = (label: string) => `export function register(on) {
    on('session.start', async ($, e, next) => { await $.command.register({name:'panel', description:'${label}'}); return next(e); });
    on('tool.call', () => ({result:'${label}'}));
  }`
  const consumer = await plugin('swap', source('old'))
  const { value, diagnostics } = runtime()
  await value.bind(binding(root))
  await value.reconcile([consumer])
  const notifications: string[][] = []
  const generations: Promise<unknown>[] = []
  const unsubscribe = value.commands.subscribe(() => {
    notifications.push(value.commands.list().map(command => command.description))
    generations.push(value.dispatch('tool.call', input, async () => ({result:'core'})))
  })
  await writeFile(consumer.entrypoints[0]!, source('new'))
  try { await value.reconcile([consumer]) }
  finally { unsubscribe() }
  expect(diagnostics).toEqual([])
  expect(notifications).toEqual([['new']])
  expect(await Promise.all(generations)).toEqual([{result:'new'}])
})

test('command commit collision rejects only the candidate and preserves the active owner', async () => {
  const source = (label: string) => `export function register(on) {
    on('session.start', async ($, e, next) => { await $.command.register({name:'panel', description:'${label}'}); return next(e); });
    on('tool.call', {tool:'${label}'}, () => ({result:'${label}'}));
  }`
  const first = await plugin('first', source('first'))
  const second = await plugin('second', source('second'))
  const { value, diagnostics } = runtime()
  await value.bind(binding(root))
  await value.reconcile([first])
  await value.reconcile([first, second])
  expect(value.commands.list().map(command => command.description)).toEqual(['first'])
  expect(await value.dispatch('tool.call', {...input, tool:'second'}, async () => ({result:'core'}))).toEqual({result:'core'})
  expect(diagnostics).toContainEqual(expect.objectContaining({plugin:'second', stage:'session.start', message:expect.stringContaining('already owned')}))
})

test('a self-declared diff provider cannot replace the built-in command', async () => {
  const consumer = await plugin('diff', `export function register(on) {
    on('session.start', async ($, e, next) => { await $.command.register({name:'diff', description:'Impostor'}); return next(e); });
  }`)
  const diagnostics: unknown[] = []
  const value = createModsRuntime({ services: { commands: () => [builtinDiff] }, onDiagnostic: event => diagnostics.push(event) })
  runtimes.push(value)
  await value.bind(binding(root))
  await value.reconcile([{ ...consumer, isNative: true, version: '1.0.0' }])
  expect(value.commands.projection([builtinDiff])).toEqual([builtinDiff])
  expect(value.commands.list()).toEqual([])
  expect(diagnostics).toContainEqual(expect.objectContaining({plugin:'diff',stage:'session.start',message:expect.stringContaining('refused: it is the built-in /diff')}))
})

const officialModsRoot = process.env.CLAUDE_CODE_OFFICIAL_MODS_FIXTURE
// Licensed upstream source stays outside the repository; set the fixture root for this integration run.
for (const registrationError of [undefined, 'command catalog unavailable']) {
  const name = registrationError === undefined
    ? 'official diff silently yields to the built-in command'
    : 'official diff still logs unexpected command registration errors'
  test.skipIf(!officialModsRoot)(name, async () => {
    const scenario = async () => {
      const pluginRoot = join(officialModsRoot!, 'diff')
      const diagnostics: unknown[] = []
      const logs: string[] = []
      const value = createModsRuntime({ services: {
        commands: () => {
          if (registrationError !== undefined) throw new Error(registrationError)
          return [builtinDiff]
        },
        uiLog: (_plugin, text) => logs.push(text),
        uiStatus: () => {},
        uiPresentation: () => ({columns:160, rows:40, isFullscreen:true, composerEmpty:true, hasDialog:false, keyboardOwned:false}),
        messages: () => [],
      }, onDiagnostic: event => diagnostics.push(event) })
      runtimes.push(value)
      await value.bind(binding(root))
      await value.reconcile([{ name:'diff', storageId:'diff@official', pluginRoot, entrypoints:[join(pluginRoot, 'hooks/register.ts')] }])
      expect(value.commands.list()).toEqual([])
      expect(value.commands.projection([builtinDiff])).toEqual([builtinDiff])
      expect(value.ui.getSnapshot()).toEqual([])
      let coreCalls = 0
      expect(await value.dispatch('command.run', {
        command:'diff', args:'', origin:{kind:'composer'}, presentation:{columns:160,isFullscreen:true},
      }, async () => { coreCalls++; return {text:'builtin diff'} })).toEqual({text:'builtin diff'})
      expect(coreCalls).toBe(1)
      expect(diagnostics).toEqual([])
      expect(logs).toEqual(registrationError === undefined ? [] : [expect.stringContaining(registrationError)])
    }
    // Run with production rejection routing rather than bun test's global Worker interception.
    const source = `
      import {expect} from 'bun:test';
      import {join} from 'node:path';
      import {createModsRuntime} from ${JSON.stringify(new URL('./runtime.ts', import.meta.url).pathname)};
      import builtinDiff from ${JSON.stringify(new URL('../../commands/diff/index.ts', import.meta.url).pathname)};
      const root=${JSON.stringify(root)}, officialModsRoot=${JSON.stringify(officialModsRoot)}, registrationError=${JSON.stringify(registrationError)}, runtimes=[];
      const binding=cwd=>({cwd,sessionId:'test',surface:'terminal',isInteractive:true});
      try {await (${scenario.toString()})()} finally {await Promise.all(runtimes.map(runtime=>runtime.dispose()))}
    `
    const child = Bun.spawn([process.execPath,'-e',source],{stdout:'pipe',stderr:'pipe'})
    const [exit, stdout, stderr] = await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()])
    if (exit !== 0) throw new Error(`${stdout}\n${stderr}`)
    expect(stderr).toBe('')
    expect(exit).toBe(0)
  })
}

const officialTypes = process.env.CLAUDE_CODE_OFFICIAL_MOD_TYPES

test.skipIf(!officialTypes)('an author plugin compiles against the complete target declarations and runs unchanged in a Worker', async () => {
  const consumer = await plugin('author-contract', `import type {On} from 'claude-code';
    import {label} from './label.js';
    export function register(on: On) {
      on('session.start', async ($, e, next) => {
        const previous = await $.store.get('starts');
        await $.store.set('starts', Number(previous ?? 0) + 1);
        await $.command.register({name:'author-contract', description:label, immediate:true});
        return next(e);
      });
      on('command.run', {command:'author-contract'}, async ($, e) => {
        await $.fs.write('author.txt', e.args);
        await $.ui.open({id:'author-pane', title:label, focus:true});
        return {text:JSON.stringify({starts:await $.store.get('starts'), text:await $.fs.read('author.txt'), session:await $.session.id(), answer:await $.store.get('last-answer')})};
      });
      on('ui.render', {component:'Pane'}, ($, e) => {
        const {Box, Text, Button} = $.ui.resolve(e);
        return <Box flexDirection="column"><Text>{label}</Text><Button key="close" label="Close" onPress={() => $.ui.close({id:'author-pane'})} /></Box>;
      });
      on('prompt.submit', ($, e, next) => next({...e, context:[...(e.context ?? []), label]}));
      on('turn.complete', async ($, e, next) => { await $.store.set('last-answer', e.answer); return next(e); });
    }`)
  const entry = join(consumer.pluginRoot, 'register.tsx')
  await writeFile(entry, await readFile(consumer.entrypoints[0]!, 'utf8'))
  consumer.entrypoints = [entry]
  await writeFile(join(consumer.pluginRoot, 'label.ts'), `export const label = 'typed author contract'`)
  const invalid = join(consumer.pluginRoot, 'invalid-contract.ts')
  await writeFile(invalid, `import type {CommandRunResult, PromptSubmitResult, ProcessRunInit} from 'claude-code';
    // @ts-expect-error refs name numeric runs, not string ids
    const run: CommandRunResult = {ref:'1'};
    // @ts-expect-error prompt context is a readonly list, not a scalar
    const prompt: PromptSubmitResult = {text:'hello', context:'invalid'};
    // @ts-expect-error timeouts are numeric milliseconds
    const init: ProcessRunInit = {timeoutMs:'100'};
    // @ts-expect-error no Node globals in a plugin realm
    process.exit(0);
    void [run, prompt, init];
  `)
  const unsupported = join(consumer.pluginRoot, 'unsupported.ts')
  await writeFile(unsupported, `import type {On} from 'claude-code'; export function register(on: On) {
    on('session.start', async ($, e, next) => { await $.tool.check({tool:'Read',input:{file_path:'sample.txt'}}); return next(e); });
  }`)
  const config = join(consumer.pluginRoot, 'tsconfig.json')
  await writeFile(config, JSON.stringify({compilerOptions:{
    target:'es2023', lib:['es2023'], types:[], module:'esnext', moduleResolution:'bundler',
    strict:true, noUncheckedIndexedAccess:true, noEmit:true, skipLibCheck:false,
    jsx:'react', jsxFactory:'h', jsxFragmentFactory:'Fragment',
  }, files:[officialTypes,entry,invalid,unsupported]}))
  const compiler = Bun.spawn([process.execPath, new URL('../../../node_modules/typescript/bin/tsc', import.meta.url).pathname, '--project', config, '--pretty', 'false'], {stdout:'pipe', stderr:'pipe', timeout:15000})
  const [exit, stdout, stderr] = await Promise.all([compiler.exited, new Response(compiler.stdout).text(), new Response(compiler.stderr).text()])
  if (exit !== 0) throw new Error(`${stdout}\n${stderr}`)
  expect(exit).toBe(0)
  const declaration = await loadModDeclaration(consumer)
  expect(declaration.modules.map(module => module.path).sort()).toEqual([entry,join(consumer.pluginRoot, 'label.ts')].sort())
  expect(declaration.calls).toEqual(['command.register','fs.read','fs.write','session.id','store.get','store.set','ui.close','ui.open','ui.resolve'])
  const diagnostics: unknown[] = []
  const value = createModsRuntime({services:{
    uiPresentation:() => ({columns:160,rows:40,isFullscreen:true,composerEmpty:true,hasDialog:false,keyboardOwned:false}),
  }, onDiagnostic:event => diagnostics.push(event)})
  runtimes.push(value)
  await value.bind(binding(root))
  await value.reconcile([consumer])
  expect(diagnostics).toEqual([])
  expect(value.commands.list()).toHaveLength(1)
  const run = () => value.dispatch('command.run', {command:'author-contract',args:'literal input',origin:{kind:'composer'},presentation:{columns:160,isFullscreen:true}}, async () => { throw Error('author command was not dispatched') })
  expect(await run()).toEqual({text:JSON.stringify({starts:1,text:'literal input',session:'test'})})
  const pane = value.ui.getSnapshot()[0]!
  expect(pane).toMatchObject({visible:true,title:'typed author contract'})
  const button = (pane.tree as any).children[1]
  await value.ui.interact(pane.id,pane.drawing!,button.press,'press','close')
  expect(value.ui.getSnapshot()).toEqual([])
  const submitted = {text:'question',origin:{kind:'composer'},wait:false,context:['existing']}
  expect(await value.dispatch('prompt.submit',submitted, async event => ({text:event.text,context:event.context,origin:event.origin}))).toEqual({text:'question',context:['existing','typed author contract'],origin:{kind:'composer'}})
  await value.bind({...binding(root),sessionId:'resumed'})
  expect(await run()).toEqual({text:JSON.stringify({starts:1,text:'literal input',session:'resumed'})})
  await value.reconcile([])
  expect(value.commands.list()).toEqual([])
  expect(value.ui.getSnapshot()).toEqual([])
  await value.reconcile([consumer])
  expect(await run()).toEqual({text:JSON.stringify({starts:2,text:'literal input',session:'resumed'})})
  const {createModTurnCompletion} = await import('./turnAdapter.js')
  const snapshot = value.capture()
  try {
    expect((await createModTurnCompletion('author-turn').complete(snapshot, {durationMs:1,aborted:false,failed:false})).result).toEqual({text:''})
  } finally { snapshot.release() }
  expect(await run()).toEqual({text:JSON.stringify({starts:2,text:'literal input',session:'resumed',answer:''})})
  expect(diagnostics).toEqual([])
  await value.reconcile([{...consumer,entrypoints:[unsupported]}])
  expect(diagnostics).toEqual([expect.objectContaining({plugin:'author-contract',stage:'reload',message:expect.stringContaining(`Mod ${unsupported}: unsupported core capability tool.check`)})])
  expect(await run()).toEqual({text:JSON.stringify({starts:2,text:'literal input',session:'resumed',answer:''})})
}, 25000)

const input = { tool: 'Read', tool_use_id: 'host-test' }
const binding = (cwd: string) => ({ cwd, sessionId: 'test', surface: 'terminal' as const, isInteractive: true })

test('real Worker maps positional fs/process/store calls into hook envelopes and respects rewrites', async () => {
  await writeFile(join(root, 'actual.txt'), 'contents')
  const rewriter = await plugin('rewrite', `export function register(on) {
    on('fs.read', ($, e, next) => next({...e, path:'actual.txt'}));
    on('process.run', ($, e, next) => next({...e, argv:[...e.argv, 'arg with spaces']}));
  }`)
  const consumer = await plugin('consumer', `export function register(on) {
    on('tool.call', async ($) => {
      const text = await $.fs.read('missing.txt');
      const process = await $.process.run(['${process.execPath.replaceAll('\\', '\\\\')}', '-e', 'process.stdout.write(process.argv[1])']);
      await $.store.set('item', {text, stdout:process.stdout});
      return {result:await $.store.get('item')};
    });
  }`)
  const { value, diagnostics } = runtime()
  await value.bind(binding(root))
  await value.reconcile([rewriter, consumer])
  expect(diagnostics).toEqual([])
  expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: { text: 'contents', stdout: 'arg with spaces' } })
  expect(diagnostics).toEqual([])
})

test('parent cancellation terminates the process owned by the interrupted hook, without core replay', async () => {
  const consumer = await plugin('cancel-process', `export function register(on) {
    on('tool.call', async ($) => { await $.process.run([${JSON.stringify(process.execPath)}, '-e', 'await Bun.write("child.pid", String(process.pid)); setInterval(() => {}, 1000)']); return {result:'unexpected'}; });
  }`)
  const { value } = runtime()
  await value.bind(binding(root))
  await value.reconcile([consumer])
  const controller = new AbortController()
  let calls = 0
  const pending = value.dispatch('tool.call', input, async () => { calls++; return {result:'core'} }, {signal:controller.signal}).then(() => null, error => error)
  let pid: number | undefined
  try {
    const deadline = Date.now() + 3000
    while (!pid) {
      pid = await readFile(join(root, 'child.pid'), 'utf8').then(Number, () => undefined)
      if (Date.now() > deadline) throw Error('Child did not start')
      if (!pid) await delay(10)
    }
    controller.abort(new Error('cancelled by parent'))
    expect((await pending).name).toBe('AbortError')
    let exited = false
    const exitDeadline = Date.now() + 700
    while (!exited && Date.now() < exitDeadline) {
      try { process.kill(pid, 0) } catch (error) { exited = (error as NodeJS.ErrnoException).code === 'ESRCH' }
      if (!exited) await delay(10)
    }
    expect(exited).toBe(true)
    expect(calls).toBe(0)
  } finally {
    controller.abort()
    await value.dispose()
    await pending
  }
})

test('parent cancellation reaches an in-flight Worker filesystem read without retiring its activation', async () => {
  const source = `
    import { expect, mock } from 'bun:test';
    import * as filesystem from 'node:fs/promises';
    const actual = {...filesystem};
    const path = ${JSON.stringify(join(root, 'cancelled-read.txt'))};
    await actual.writeFile(path, Buffer.alloc(128 * 1024, 65));
    let entered, unblock, closed;
    const reading = new Promise(resolve => { entered = resolve });
    const barrier = new Promise(resolve => { unblock = resolve });
    const closing = new Promise(resolve => { closed = resolve });
    let reads = 0;
    mock.module('node:fs/promises', () => ({...actual, open: async (...args) => {
      const file = await actual.open(...args);
      if (args[0] !== path) return file;
      return {
        async read(...args) {
          reads++;
          if (reads === 1) { entered(); await barrier; }
          return file.read(...args);
        },
        async close() { try { await file.close(); } finally { closed(); } },
      };
    }}));
    const {createModsRuntime} = await import(${JSON.stringify(new URL('./runtime.ts', import.meta.url).pathname)});
    const runtime = createModsRuntime();
    const controller = new AbortController();
    let coreCalls = 0;
    let pending;
    try {
      await runtime.bind(${JSON.stringify(binding(root))});
      await runtime.reconcile([${JSON.stringify(await plugin('cancel-fs', `export function register(on) {
        on('tool.call', async ($, e) => ({result:await $.fs.read(e.path)}));
      }`))}]);
      pending = runtime.dispatch('tool.call', {...${JSON.stringify(input)}, path}, async () => {
        coreCalls++; return {result:'core'};
      }, {signal:controller.signal}).then(() => null, error => error);
      await reading;
      controller.abort();
      unblock();
      expect((await pending).name).toBe('AbortError');
      await closing;
      expect(reads).toBe(1);
      expect(coreCalls).toBe(0);
      const next = ${JSON.stringify(join(root, 'after-cancel.txt'))};
      await actual.writeFile(next, 'activation remains live');
      expect(await runtime.dispatch('tool.call', {...${JSON.stringify(input)}, path:next}, async () => {
        coreCalls++; return {result:'core'};
      })).toEqual({result:'activation remains live'});
      expect(coreCalls).toBe(0);
    } finally {
      controller.abort();
      unblock();
      await runtime.dispose();
      await pending;
      mock.restore();
    }
  `
  const child = Bun.spawn([process.execPath, '-e', source], {stdout:'pipe', stderr:'pipe', timeout:10000})
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (exit !== 0) throw new Error(`${stdout}\n${stderr}`)
  expect(exit).toBe(0)
}, 15000)

test('session messages read a stable live getter and rebinding updates the actual working directory', async () => {
  const consumer = await plugin('session', `export function register(on) {
    on('tool.call', async ($) => ({result: {
      cwd:await $.session.cwd(), id:await $.session.id(), messages:await $.session.messages(),
      text:await $.fs.read('state.txt')
    }}));
  }`)
  let messages = [{ role: 'user', content: 'first' }]
  const { value, diagnostics } = runtime(() => messages)
  await writeFile(join(root, 'state.txt'), 'first')
  await value.bind(binding(root))
  await value.reconcile([consumer])
  expect(diagnostics).toEqual([])
  const first = await value.dispatch('tool.call', input, async () => ({ result: 'core' })) as any
  expect(first.result.messages).toEqual(messages)
  const next = join(root, 'second')
  await mkdir(next)
  await writeFile(join(next, 'state.txt'), 'second')
  messages = [{ role: 'user', content: 'second' }]
  await value.bind({ ...binding(next), sessionId: 'resumed' })
  const second = await value.dispatch('tool.call', input, async () => ({ result: 'core' })) as any
  expect(second.result).toEqual({ cwd: next, id: 'resumed', messages, text: 'second' })
})

test('withholding a core noun prevents host side effects without removing other capabilities', async () => {
  const policy = await plugin('policy', `export function register(on) {
    on('engine.create', async ($, e, next) => { const below=await next(e); return {clock:below.clock, process:below.process, store:below.store, session:below.session, command:below.command}; });
  }`)
  const consumer = await plugin('write', `export function register(on) {
    on('tool.call', async ($) => { await $.fs.write('forbidden.txt', 'not written'); return {result:'bad'}; });
  }`)
  const { value, diagnostics } = runtime()
  await value.bind(binding(root))
  await value.reconcile([policy, consumer])
  expect(diagnostics).toEqual([])
  expect(await value.dispatch('tool.call', input, async () => ({ result: 'core' }))).toEqual({ result: 'core' })
  expect(diagnostics).toEqual([expect.objectContaining({ plugin: 'write', message: expect.stringContaining('withheld') })])
  expect(await readFile(join(root, 'forbidden.txt')).then(() => 'exists', error => error.code)).toBe('ENOENT')
})

test('settings.read exposes accepted settings through the real Worker and returns independent snapshots', async () => {
  const policy = { allowedMcpServers: [{ serverName: 'corp' }], env: { FIXTURE: 'accepted' } }
  setCachedSettingsForSource('policySettings', policy)
  setSessionSettingsCache({ settings: { model: 'merged-fixture' }, errors: [] })
  const consumer = await plugin('settings-reader', `export function register(on) {
    on('tool.call', async ($) => {
      const policy = await $.settings.read({source:'policy'});
      try { policy.env.FIXTURE = 'changed by plugin'; } catch (error) {
        if (!String(error).includes('readonly')) throw error;
      }
      return {result:{policy:await $.settings.read({source:'policy'}), merged:await $.settings.read()}};
    });
  }`)
  expect((await loadModDeclaration(consumer)).calls).toEqual(['settings.read'])
  const { value, diagnostics } = runtime()
  await value.reconcile([consumer])
  expect(diagnostics).toEqual([])
  const result = await value.dispatch('tool.call', input, async () => ({result:'core'}))
  expect(diagnostics).toEqual([])
  expect(result).toEqual({result:{policy, merged:{model:'merged-fixture'}}})
  setCachedSettingsForSource('policySettings', { model: 'updated-policy', env: { FIXTURE: 'updated' } })
  expect(await value.dispatch('tool.call', input, async () => ({result:'core'}))).toEqual({result:{policy:{model:'updated-policy',env:{FIXTURE:'updated'}}, merged:{model:'merged-fixture'}}})
  expect(diagnostics).toEqual([])
})

test('settings.read skips only the calling hook, preserving same-plugin policy gating and pinned origin', async () => {
  setCachedSettingsForSource('policySettings', { allowedMcpServers: [{ serverName: 'corp' }] })
  const policy = await plugin('settings-guard', `export function register(on) {
    on('settings.read', ($, e, next) => next.to(e, 'append'));
    on('tool.call', async ($) => ({result:await $.settings.read({source:'policy'})}));
  }`)
  const witness = await plugin('settings-stripper', `export function register(on) {
    on('settings.read', () => ({value:{stripped:true}}));
  }`)
  const observer = await plugin('settings-observer', `export function register(on) {
    on('settings.read', async ($, e, next) => ({value:{...(await next(e)).value, origin:next.origin}}));
  }`)
  const { value, diagnostics } = runtime()
  await value.reconcile([{...policy, tier:'prepend'}, witness, {...observer, tier:'append'}])
  expect(await value.dispatch('tool.call', input, async () => ({result:'core'}))).toEqual({result:{
    allowedMcpServers:[{serverName:'corp'}], origin:{plugin:'settings-guard',tier:'prepend'},
  }})
  expect(diagnostics).toEqual([])
})

test('settings.read remains hookable for rewrite, deny and same-event reentry', async () => {
  setCachedSettingsForSource('userSettings', { model:'user-fixture' })
  setCachedSettingsForSource('policySettings', { model:'policy-fixture' })
  const middleware = await plugin('settings-rewriter', `export function register(on) {
    on('settings.read', async ($, e) => {
      if (e.source === 'local') return {deny:'settings denied'};
      return {value:await $.settings.read({source:'user'})};
    });
    on('settings.read', async ($, e, next) => ({value:{...(await next(e)).value, source:e.source}}));
  }`)
  const consumer = await plugin('settings-consumer', `export function register(on) {
    on('tool.call', async ($) => {
      const result = await $.settings.read({source:'policy'});
      try { await $.settings.read({source:'local'}); } catch (error) { return {result:{...result, denied:error.message}}; }
      return {result:'not denied'};
    });
  }`)
  const { value, diagnostics } = runtime()
  await value.reconcile([middleware, consumer])
  expect(await value.dispatch('tool.call', input, async () => ({result:'core'}))).toEqual({result:{model:'user-fixture',source:'user',denied:'settings denied'}})
  expect(diagnostics).toEqual([])
})

test('settings.read captured capability is revoked by withholding and recovers when withholding is removed', async () => {
  setCachedSettingsForSource('policySettings', { model:'accepted-policy' })
  const consumer = await plugin('settings-captured', `let read; export function register(on) {
    on('tool.call', async ($) => {
      if (!read) read = () => $.settings.read({source:'policy'});
      try { return {result:await read()}; } catch (error) { return {result:error.message}; }
    });
  }`)
  const policy = await plugin('settings-withholder', `export function register(on) {
    on('engine.create', async ($, e, next) => { const below=await next(e); return {clock:below.clock,fs:below.fs,process:below.process,store:below.store,session:below.session,command:below.command,ui:below.ui}; });
  }`)
  const { value, diagnostics } = runtime()
  await value.reconcile([consumer])
  expect(diagnostics).toEqual([])
  expect(await value.dispatch('tool.call', input, async () => ({result:'core'}))).toEqual({result:{model:'accepted-policy'}})
  await value.reconcile([{...policy,tier:'prepend'}, consumer])
  expect(diagnostics).toEqual([])
  expect(await value.dispatch('tool.call', input, async () => ({result:'core'}))).toEqual({result:expect.stringContaining('withheld')})
  await value.reconcile([consumer])
  expect(diagnostics).toEqual([])
  expect(await value.dispatch('tool.call', input, async () => ({result:'core'}))).toEqual({result:{model:'accepted-policy'}})
  await value.reconcile([])
  expect(await value.dispatch('tool.call', input, async () => ({result:'core'}))).toEqual({result:'core'})
  expect(diagnostics).toEqual([])
})

test('settings.read rejects invalid Worker arguments instead of reading merged settings', async () => {
  setSessionSettingsCache({settings:{model:'must-not-leak'},errors:[]})
  const consumer = await plugin('settings-invalid', `export function register(on) {
    on('tool.call', async ($) => {
      const rejected = [];
      for (const args of [null, [], 'policy', {source:'policySettings'}, {source:null}]) {
        try { await $.settings.read(args); rejected.push(false); } catch { rejected.push(true); }
      }
      return {result:rejected};
    });
  }`)
  const { value, diagnostics } = runtime()
  await value.reconcile([consumer])
  expect(await value.dispatch('tool.call', input, async () => ({result:'core'}))).toEqual({result:[true,true,true,true,true]})
  expect(diagnostics).toEqual([])
})

test('settings.read cannot be replaced by a plugin-provided settings noun', async () => {
  setCachedSettingsForSource('policySettings', {model:'accepted-policy'})
  const impostor = await plugin('settings-impostor', `export function register(on) {
    on('engine.create', async ($, e, next) => { const below=await next(e); return {...below,settings:{read:() => ({model:'forged'})}}; });
  }`)
  const consumer = await plugin('settings-owner-reader', `export function register(on) {
    on('tool.call', async ($) => ({result:await $.settings.read({source:'policy'})}));
  }`)
  const { value, diagnostics } = runtime()
  await value.reconcile([impostor,consumer])
  expect(await value.dispatch('tool.call', input, async () => ({result:'core'}))).toEqual({result:{model:'accepted-policy'}})
  expect(diagnostics).toEqual([expect.objectContaining({plugin:'settings-impostor',stage:'engine.create',message:expect.stringContaining('may not replace noun settings')})])
})

test('settings.read is refused during unadmitted engine construction', async () => {
  setCachedSettingsForSource('policySettings', { model:'accepted-policy' })
  const consumer = await plugin('settings-candidate', `let result; export function register(on) {
    on('engine.create', async ($, e, next) => {
      const below=await next(e);
      try { result=await below.settings.read({source:'policy'}); } catch (error) { result=error.message; }
      return {...below};
    });
    on('tool.call', () => ({result}));
  }`)
  const { value, diagnostics } = runtime()
  await value.reconcile([consumer])
  expect(diagnostics).toEqual([])
  expect(await value.dispatch('tool.call', input, async () => ({result:'core'}))).toEqual({result:'Module has not been admitted'})
  expect(diagnostics).toEqual([])
})
