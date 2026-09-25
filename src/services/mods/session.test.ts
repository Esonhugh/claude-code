import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import chokidar, { type FSWatcher } from 'chokidar'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LoadedPlugin } from '../../types/plugin.js'
import { disposeModsHosts } from '../../utils/gracefulShutdown.js'
import * as shutdown from '../../utils/gracefulShutdown.js'
import { refreshPluginRuntimes } from '../../utils/plugins/cacheUtils.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import * as secureStorage from '../../utils/secureStorage/index.js'
import * as settingsStorage from '../../utils/settings/settings.js'
import * as debug from '../../utils/debug.js'
import { clearPluginOptionsCache, savePluginOptions } from '../../utils/plugins/pluginOptionsStorage.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import type { PrepareModPluginsSettings } from './plugins.js'
import { createModsRuntime, type ModsRuntime } from './runtime.js'
import { describeModTool } from './toolCatalog.js'
import { runToolUse } from '../tools/toolExecution.js'
import { createAssistantMessage } from '../../utils/messages.js'
import { getEmptyToolPermissionContext, type Tool, type ToolUseContext } from '../../Tool.js'
import { z } from 'zod/v4'
import { getIsInteractive, setIsInteractive } from '../../bootstrap/state.js'
import { resetHooksConfigSnapshot } from '../../utils/hooks/hooksConfigSnapshot.js'
import { resetSettingsCache, setCachedSettingsForSource, setSessionSettingsCache } from '../../utils/settings/settingsCache.js'
import {
  createModsSession,
  type ModsSession,
  type ModsSessionOptions,
} from './session.js'

const cleanups: (() => Promise<unknown> | void)[] = []
beforeEach(() => {
  const storage = spyOn(secureStorage, 'getSecureStorage').mockReturnValue({
    read: () => ({}),
    update: () => {
      throw new Error('unexpected secure storage write')
    },
  } as unknown as ReturnType<typeof secureStorage.getSecureStorage>)
  clearPluginOptionsCache()
  cleanups.push(() => {
    storage.mockRestore()
    clearPluginOptionsCache()
  })
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const settings = () => ({
  userSettings: null,
  flagSettings: null,
  policySettings: null,
  hookPolicy: { managedOnly: false, allDisabled: false },
})
const binding = {
  cwd: '/tmp',
  sessionId: 'first',
  surface: null,
  isInteractive: false,
} as const
const input = { tool: 'Bash', tool_use_id: 'call', command: 'test' }
const core = async () => ({ result: 'core' })

async function plugin(
  source = `let starts = 0; export function register(on) {
  on('session.start', async ($, e, next) => { await $.clock.sleep(15); starts++; return next(e) });
  on('tool.call', () => ({ result: starts }));
}`,
): Promise<LoadedPlugin> {
  const root = await mkdtemp(join(tmpdir(), 'mods-session-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'register.ts'), source)
  return {
    name: 'fixture',
    manifest: { name: 'fixture' },
    path: root,
    source: 'fixture@inline',
    repository: 'fixture@inline',
    enabled: true,
    hookModules: [
      { configPath: join(root, 'hooks.json'), paths: ['./register.ts'] },
    ],
  }
}
function session(options: Partial<ModsSessionOptions> = {}): ModsSession {
  const host = createModsSession({
    isTrusted: true,
    getSettings: settings,
    loadPlugins: async () => [],
    ...options,
  })
  cleanups.push(() => host.dispose())
  return host
}

function watchEvents() {
  const original = chokidar.watch.bind(chokidar)
  const watchers: FSWatcher[] = []
  const ready: Promise<void>[] = []
  const watch = spyOn(chokidar, 'watch').mockImplementation((...args) => {
    const watcher = original(...args)
    watchers.push(watcher)
    ready.push(new Promise(resolve => watcher.once('ready', resolve)))
    return watcher
  })
  cleanups.push(() => watch.mockRestore())
  return { watchers, ready, watch }
}

describe('Mods CLI session host', () => {
  test('Worker registered agents publish into next-turn ToolUseContext state and disappear on unload', async () => {
    const mod = await plugin(`export function register(on) {
      on('command.run', async $ => ({text:JSON.stringify(await $.agent.register({name:'reviewer',description:'Review',prompt:'Review carefully',model:'inherit'}))}));
    }`)
    const host = session({loadPlugins:async()=>[mod]})
    let state = {agentDefinitions:{activeAgents:[],allAgents:[]},plugins:{errors:[]}} as unknown as import('../../state/AppState.js').AppState
    await host.bind(binding, update => { state = update(state) })
    const snapshot = host.runtime!.capture()
    try {
      await snapshot.dispatch('command.run',{},async()=>({}))
      const context = {options:{agentDefinitions:state.agentDefinitions}} as ToolUseContext
      expect(context.options.agentDefinitions.activeAgents).toHaveLength(1)
      expect(context.options.agentDefinitions.activeAgents[0]).toMatchObject({agentType:'fixture:reviewer',whenToUse:'Review',source:'plugin',model:'inherit'})
      await host.refresh([])
      expect(state.agentDefinitions).toEqual({activeAgents:[],allAgents:[]})
    } finally { snapshot.release() }
  })

  test('does not load or instantiate a Worker before trust, or without declarations', async () => {
    let loads = 0
    let creates = 0
    const options = {
      loadPlugins: async () => {
        loads++
        return []
      },
      createRuntime: () => {
        creates++
        throw new Error('unexpected Worker')
      },
    }
    const untrusted = session({ ...options, isTrusted: false })
    await untrusted.bind(binding)
    await untrusted.refresh()
    expect(loads).toBe(0)
    const empty = session(options)
    await empty.bind(binding)
    await empty.bind(binding)
    expect(loads).toBe(1)
    expect(creates).toBe(0)
    expect(empty.runtime).toBeUndefined()
  })

  test('unsupported hosts never create a runtime even with declarations', async () => {
    const declaration = await plugin()
    const events: string[] = []
    const host = session({
      loadPlugins: async () => [declaration],
      getDisabledReason: () => 'Mods are unsupported in remote/SSH sessions',
      onDiagnostic: event => events.push(event.stage),
      createRuntime: () => {
        throw new Error('unexpected Worker')
      },
    })
    await host.bind(binding)
    expect(host.runtime).toBeUndefined()
    expect(events).toEqual(['unsupported'])
  })

  test('config exposes plugin fields, writes scoped options and reloads the next activation', async () => {
    const declaration = await plugin(`export function register(on,options) {
      on('tool.call',async ($,e) => ({result:e.list ? await $.config.list() : options.mode}));
    }`)
    declaration.manifest.userConfig = {mode:{type:'string',title:'Mode',description:'Choose mode',default:'a',options:['a','b']}}
    let current: PrepareModPluginsSettings = settings()
    const write = spyOn(settingsStorage, 'updateSettingsForSource').mockImplementation((source, update) => {
      expect(source).toBe('userSettings')
      expect(Object.keys(update)).toEqual(['pluginConfigs'])
      current = {...current,userSettings:{...current.userSettings,...update}}
      settingsChangeDetector.notifyChange('userSettings')
      return {settings:current.userSettings!,error:null} as ReturnType<typeof settingsStorage.updateSettingsForSource>
    })
    cleanups.push(() => write.mockRestore())
    const host = session({loadPlugins:async () => [declaration],getSettings:() => current})
    await host.bind(binding)
    expect(await host.runtime!.dispatch('tool.call',{list:true},core)).toEqual({result:[{
      key:'fixture.mode',label:'Mode',description:'Choose mode',kind:'choice',value:'a',options:['a','b'],provider:{plugin:'fixture@inline',tier:'user'},isLocked:false,
    }]})
    expect(await host.runtime!.config.set({key:'fixture.mode',value:'b'},{kind:'composer'})).toEqual({value:'b'})
    await host.bind(binding)
    expect(await host.runtime!.dispatch('tool.call',{},core)).toEqual({result:'b'})
    current = {...current,policySettings:{pluginConfigs:{'fixture@inline':{options:{mode:'a'}}}}}
    expect((await host.runtime!.config.list())[0]).toMatchObject({value:'a',isLocked:true})
    expect(await host.runtime!.config.set({key:'fixture.mode',value:'b'},{kind:'bridge'})).toEqual({deny:expect.stringContaining('locked')})
    expect(write).toHaveBeenCalledTimes(1)
  })

  test('inline config reads and writes the official bare plugin name key', async () => {
    const declaration = await plugin(`export function register(on,options) {
      on('tool.call', () => ({result:options.mode}));
    }`)
    declaration.manifest.userConfig = {mode:{type:'string',title:'Mode',description:'Choose mode',default:'a',options:['a','b']}}
    let current: PrepareModPluginsSettings = {
      ...settings(),
      userSettings:{pluginConfigs:{fixture:{options:{mode:'b'}}}} as SettingsJson,
    }
    const write = spyOn(settingsStorage, 'updateSettingsForSource').mockImplementation((source, update) => {
      expect(source).toBe('userSettings')
      expect(update).toEqual({pluginConfigs:{fixture:{options:{mode:'a'}}}})
      current = {...current,userSettings:{...current.userSettings,...update}}
      settingsChangeDetector.notifyChange('userSettings')
      return {settings:current.userSettings!,error:null} as ReturnType<typeof settingsStorage.updateSettingsForSource>
    })
    cleanups.push(() => write.mockRestore())
    const host = session({loadPlugins:async () => [declaration],getSettings:() => current})
    await host.bind(binding)
    expect(await host.runtime!.dispatch('tool.call',{},core)).toEqual({result:'b'})
    expect(await host.runtime!.config.set({key:'fixture.mode',value:'a'},{kind:'composer'})).toEqual({value:'a'})
    expect(write).toHaveBeenCalledTimes(1)
  })

  test('config keeps descriptions cached across ordinary settings changes while publishing live values', async () => {
    const declaration = await plugin(`let descriptions = 0; export function register(on) {
      on('config.describe', ($, e, next) => next({ ...e, label: e.label + ++descriptions }));
      on('tool.call', async $ => { await $.ui.invalidate('config.describe'); return { result: 'invalidated' }; });
    }`)
    let verbose = false
    const host = session({ loadPlugins: async () => [declaration] })
    await host.bind(binding, undefined, { configRows: () => [{
      key: 'verbose', label: 'Verbose', kind: 'boolean', value: verbose,
      provider: { plugin: 'engine', tier: 'core' }, isLocked: false,
      set: value => { verbose = value as boolean; settingsChangeDetector.notifyChange('userSettings') },
    }] })
    expect(await host.runtime!.config.list()).toMatchObject([{ label: 'Verbose1', value: false }])
    let changes = 0
    const unsubscribe = host.runtime!.config.subscribe(() => { changes++ })
    cleanups.push(unsubscribe)
    await host.runtime!.config.set({ key: 'verbose', value: true }, { kind: 'composer' })
    expect(await host.runtime!.config.list()).toMatchObject([{ label: 'Verbose1', value: true }])
    expect(changes).toBeGreaterThan(0)
    const before = changes
    verbose = false
    settingsChangeDetector.notifyChange('userSettings')
    expect(changes).toBeGreaterThan(before)
    expect(await host.runtime!.config.list()).toMatchObject([{ label: 'Verbose1', value: false }])
    await host.runtime!.dispatch('tool.call', {}, core)
    expect(await host.runtime!.config.list()).toMatchObject([{ label: 'Verbose2', value: false }])
  })

  test('config lists and writes enabled plugin fields even when the plugin declares no hook modules', async () => {
    const declaration = await plugin()
    declaration.hookModules = undefined
    declaration.manifest.userConfig = { mode: { type: 'string', title: 'Mode', description: 'Choose mode', default: 'a', options: ['a', 'b'] } }
    let current: PrepareModPluginsSettings = settings()
    const write = spyOn(settingsStorage, 'updateSettingsForSource').mockImplementation((source, update) => {
      expect(source).toBe('userSettings')
      current = { ...current, userSettings: { ...current.userSettings, ...update } }
      settingsChangeDetector.notifyChange('userSettings')
      return { settings: current.userSettings!, error: null } as ReturnType<typeof settingsStorage.updateSettingsForSource>
    })
    cleanups.push(() => write.mockRestore())
    const host = session({ loadPlugins: async () => [declaration], getSettings: () => current })
    await host.bind(binding)
    expect(host.runtime?.config).toBeDefined()
    expect(await host.runtime!.config.list()).toMatchObject([{ key: 'fixture.mode', value: 'a' }])
    expect(await host.runtime!.config.set({ key: 'fixture.mode', value: 'b' }, { kind: 'composer' })).toEqual({ value: 'b' })
    await host.bind(binding)
    expect(await host.runtime!.config.list()).toMatchObject([{ key: 'fixture.mode', value: 'b' }])
    expect(write).toHaveBeenCalledTimes(1)
    await host.refresh([{ ...declaration, enabled: false }])
    expect(await host.runtime!.config.list()).toEqual([])
  })

  test('config preserves an unset multiple field as a list and accepts its first Worker write', async () => {
    const declaration = await plugin(`export function register(on, options) {
      on('tool.call', async ($, e) => ({ result: e.list ? await $.config.list() : e.saved ? options.labels : await $.config.set({ key: 'fixture.labels', value: e.value }) }));
    }`)
    declaration.manifest.userConfig = { labels: { type: 'string', title: 'Labels', description: 'Choose labels', multiple: true } }
    let current: PrepareModPluginsSettings = settings()
    const write = spyOn(settingsStorage, 'updateSettingsForSource').mockImplementation((source, update) => {
      expect(source).toBe('userSettings')
      current = { ...current, userSettings: { ...current.userSettings, ...update } }
      settingsChangeDetector.notifyChange('userSettings')
      return { settings: current.userSettings!, error: null } as ReturnType<typeof settingsStorage.updateSettingsForSource>
    })
    cleanups.push(() => write.mockRestore())
    const host = session({ loadPlugins: async () => [declaration], getSettings: () => current })
    await host.bind(binding)
    expect(await host.runtime!.dispatch('tool.call', { list: true }, core)).toMatchObject({ result: [{ key: 'fixture.labels', kind: 'text', value: [] }] })
    expect(await host.runtime!.dispatch('tool.call', { value: ['one', 'two'] }, core)).toEqual({ result: { value: ['one', 'two'] } })
    await host.bind(binding)
    expect(await host.runtime!.dispatch('tool.call', { saved: true }, core)).toEqual({ result: ['one', 'two'] })
    expect(await host.runtime!.dispatch('tool.call', { value: 'not a list' }, core)).toEqual({ result: { deny: expect.stringContaining('Invalid value') } })
    expect(write).toHaveBeenCalledTimes(1)
  })

  test('/config key=value invokes production config.set with bridge origin and does not open a dialog', async () => {
    const declaration = await plugin(`export function register(on) {
      on('config.set',($,e,next)=> e.origin.kind==='bridge' ? {deny:'bridge refused'} : next(e));
    }`)
    let verbose = false
    const host = session({loadPlugins:async () => [declaration]})
    await host.bind(binding,undefined,{configRows:() => [{key:'verbose',label:'Verbose output',kind:'boolean',value:verbose,provider:{plugin:'engine',tier:'core'},isLocked:false,set:value=>{verbose=value as boolean}}]})
    const {call} = await import('../../commands/config/config.js')
    const results: (string | undefined)[] = []
    const context = {mods:host.runtime,modCommand:{origin:{kind:'bridge'}}} as Parameters<typeof call>[1]
    expect(await call(text=>{results.push(text)},context,'verbose=true')).toBeNull()
    expect(results).toEqual(['bridge refused'])
    expect(verbose).toBe(false)
    expect(await call(text=>{results.push(text)},{...context,modCommand:{...context.modCommand!,origin:{kind:'composer'}}},'verbose=true')).toBeNull()
    expect(verbose).toBe(true)
    expect(results.at(-1)).toBe('verbose = true')
  })

  test('bind supplies live host services before start and publishes command changes without a render race', async () => {
    const declaration = await plugin(`let first; export function register(on) {
      on('session.start', async ($, e, next) => { first = await $.session.messages(); await $.command.register({name:'panel', description:'Panel'}); return next(e); });
      on('tool.call', async ($) => ({result:{first, current:await $.session.messages()}}));
    }`)
    const host = session({loadPlugins: async () => [declaration]})
    let messages = [{role:'user', text:'initial', toolUses:[]}]
    const published: string[][] = []
    const unsubscribe = host.commands.subscribe(() => published.push(host.commands.getSnapshot().map(command => command.name)))
    cleanups.push(unsubscribe)
    expect(host.commands.getSnapshot()).toBe(host.commands.getSnapshot())
    await host.bind(binding, undefined, {messages: () => messages, commands: () => []})
    expect(host.commands.getSnapshot().map(command => command.name)).toEqual(['panel'])
    expect(published.at(-1)).toEqual(['panel'])
    messages = [{role:'user', text:'resumed', toolUses:[]}]
    await host.bind({...binding, sessionId:'resumed'})
    expect(await host.runtime!.dispatch('tool.call', input, core)).toEqual({result:{
      first:[{role:'user', text:'initial', toolUses:[]}], current:messages,
    }})
    await host.refresh([])
    expect(host.commands.getSnapshot()).toEqual([])
    expect(published.at(-1)).toEqual([])
  })

  test('tools projection publishes session-start registrations and removes retired versions while preserving base tools', async () => {
    const source = (description: string) => `export function register(on) {
      on('session.start',async ($,e,next) => {
        await $.tool.register({name:'echo',description:'${description}',inputSchema:{type:'object',properties:{}}});
        return next(e);
      });
    }`
    const declaration = await plugin(source('first'))
    const host = session({loadPlugins:async () => [declaration]})
    const base = {name:'BaseFixture'} as Tool
    const published: string[][] = []
    expect(host.tools).toBeDefined()
    const unsubscribe = host.tools.subscribe(() => published.push(host.tools.getSnapshot().map(tool => tool.name)))
    cleanups.push(unsubscribe)
    expect(host.tools.projection([base])).toEqual([base])
    expect(host.tools.getSnapshot()).toBe(host.tools.getSnapshot())
    await host.bind(binding)
    const first = host.tools.projection([base])
    expect(first.map(tool => tool.name)).toEqual(['BaseFixture','mcp__fixture__echo'])
    expect(published.at(-1)).toEqual(['mcp__fixture__echo'])
    await writeFile(join(declaration.path,'register.ts'),source('second'))
    await host.refresh([declaration])
    const second = host.tools.projection(first)
    expect(second).toHaveLength(2)
    expect(second[0]).toBe(base)
    expect(second[1]).not.toBe(first[1])
    await host.refresh([])
    expect(host.tools.projection(second)).toEqual([base])
    expect(published.at(-1)).toEqual([])
  })

  test('MCP plugins without hook modules retain settings provenance across captured generations', async () => {
    const declaration = await plugin(`export function register(on) {
      on('tool.describe', ($, e) => ({description:e.description+':'+e.provider.plugin+':'+e.provider.tier}));
    }`)
    const provider = {...declaration, name:'mcp-only', manifest:{name:'mcp-only'}, source:'mcp-only@marketplace', repository:'mcp-only@marketplace', hookModules:undefined}
    let current: PrepareModPluginsSettings = {...settings(), userSettings:{appendPlugins:['mcp-only@marketplace']}}
    const host = session({loadPlugins:async () => [declaration,provider],getSettings:() => current})
    await host.bind(binding)
    const tool = {name:'mcp__server__read',isMcp:true,mcpInfo:{serverName:'server',toolName:'read',pluginSource:'mcp-only@marketplace'}} as Tool
    const before = host.runtime!.capture()
    try {
      expect(await describeModTool(before, tool, 'base')).toEqual({description:'base:mcp-only@marketplace:append'})
      current = settings()
      await host.refresh()
      const after = host.runtime!.capture()
      try {
        expect(await describeModTool(after, tool, 'base')).toEqual({description:'base:mcp-only@marketplace:user'})
        expect(await describeModTool(before, tool, 'uncached')).toEqual({description:'uncached:mcp-only@marketplace:append'})
      } finally { after.release() }
      current = {...settings(), policySettings:{enabledPlugins:{'mcp-only@marketplace':true}}}
      await host.refresh()
      const managed = host.runtime!.capture()
      try {
        expect(managed.pluginOrigin?.('mcp-only@marketplace')).toEqual({plugin:'mcp-only@marketplace',tier:'prepend'})
        // Native sec-default protects the managed provider from the user hook.
        expect(await describeModTool(managed, tool, 'base')).toEqual({description:'base',isDeferred:true})
      } finally { managed.release() }
    } finally { before.release() }
  })

  test('the first prompt barrier awaits actual Worker session.start; clear/rebind does not restart', async () => {
    const declaration = await plugin()
    let loads = 0
    const host = session({
      loadPlugins: async () => {
        loads++
        return [declaration]
      },
    })
    let promptStarted = false
    const first = host.bind(binding).then(() => {
      promptStarted = true
    })
    await Promise.resolve()
    expect(promptStarted).toBe(false)
    await Promise.all([first, host.bind(binding)])
    expect(await host.runtime!.dispatch('tool.call', input, core)).toEqual({
      result: 1,
    })
    await host.bind({
      ...binding,
      sessionId: 'cleared',
      cwd: declaration.path,
    })
    await host.refresh([declaration])
    expect(host.runtime!.hasHooks('tool.call')).toBe(true)
    expect(await host.runtime!.dispatch('tool.call', input, core)).toEqual({
      result: 1,
    })
    expect(loads).toBe(1)
  })

  test('enable keeps a concurrent prompt behind a pending real Worker session.start', async () => {
    const declaration = await plugin(`let started = false; export function register(on) {
      on('session.start', async ($, e, next) => { await $.clock.sleep(200); started = true; return next(e) });
      on('tool.call', () => ({ result: started }));
    }`)
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const original = globalThis.setTimeout
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback, ms, ...args) => {
      if (ms !== 200) return original(callback, ms, ...args)
      entered.resolve()
      return original(() => { void finish.promise.then(() => callback(...args)) }, 0)
    }) as typeof setTimeout)
    cleanups.push(() => timer.mockRestore())
    cleanups.push(() => finish.resolve())
    const host = session()
    await host.bind(binding)
    let enabled = false
    const enabling = host.refresh([declaration]).then(() => { enabled = true })
    await entered.promise
    let promptStarted = false
    const prompt = host.bind(binding).then(async () => {
      promptStarted = true
      return host.runtime!.dispatch('tool.call', input, core)
    })
    await Bun.sleep(5)
    expect(enabled).toBe(false)
    expect(promptStarted).toBe(false)
    finish.resolve()
    await enabling
    expect(await prompt).toEqual({ result: true })
  })

  test('a failed declaration load reports refresh and permits an explicit retry', async () => {
    const declaration = await plugin()
    let fail = true
    const events: string[] = []
    const host = session({
      loadPlugins: async () => {
        if (fail) throw new Error('fixture declaration load failed')
        return [declaration]
      },
      onDiagnostic: event => events.push(event.stage),
    })
    await expect(host.bind(binding)).rejects.toThrow('fixture declaration load failed')
    expect(host.runtime).toBeUndefined()
    expect(events).toEqual(['refresh'])
    fail = false
    await host.refresh()
    await host.bind(binding)
    expect(await host.runtime!.dispatch('tool.call', input, core)).toEqual({ result: 1 })
  })

  test.each(['strictPluginOnlyCustomization', 'allowManagedHooksOnly'] as const)('managed %s still blocks external evaluation before Worker creation', async restriction => {
    const declaration = await plugin('throw Error("must not evaluate"); export function register(on) {}')
    const events: string[] = []
    const host = session({
      loadPlugins: async () => [declaration],
      getSettings: () => ({ ...settings(), policySettings: { [restriction]: true } }),
      createRuntime: () => { throw Error('must not create Worker') },
      onDiagnostic: event => events.push(event.message),
    })
    await host.bind(binding)
    expect(host.runtime).toBeUndefined()
    expect(events.some(message => message.includes('Managed Mods protection'))).toBe(true)
  })

  test('managed sessions seat a host-owned sec-default before user settings interceptors', async () => {
    const declaration = await plugin(`export function register(on) {
      on('settings.read', () => ({value:{rewritten:true}}));
      on('classic.PreToolUse', () => ({allow:true}));
      on('tool.call', ($, e, next) => next(e));
    }`)
    const events: string[] = []
    const host = session({
      getSettings: () => ({...settings(), policySettings:{enabledPlugins:{}}}),
      loadPlugins: async () => [declaration],
      onDiagnostic: event => events.push(event.message),
    })
    await host.bind(binding)
    expect(await host.runtime!.dispatch('settings.read', {source:'policy'}, async () => ({value:{managed:true}}))).toEqual({value:{managed:true}})
    expect(await host.runtime!.dispatch('classic.PreToolUse', input, async () => ({deny:'managed decision'}))).toEqual({deny:'managed decision'})
    expect(events).toEqual([])
  })

  test('native seat follows managed-list and organization changes without restarting user activations', async () => {
    const declaration = await plugin(`let starts=0; export function register(on) {
      on('session.start', ($, e, next) => {starts++;return next(e)});
      on('classic.PreToolUse', () => ({allow:true}));
      on('tool.call', () => ({result:starts}));
    }`)
    let current: PrepareModPluginsSettings = {...settings(), subscriptionType:'team'}
    const host = session({getSettings: () => current, loadPlugins: async () => [declaration]})
    const decision = () => host.runtime!.dispatch('classic.PreToolUse',input,async () => ({deny:'core'}))
    await host.bind(binding)
    expect(await decision()).toEqual({deny:'core'})
    current = {...current, policySettings:{prependPlugins:[]}}
    settingsChangeDetector.notifyChange('policySettings')
    await host.bind(binding)
    expect(await decision()).toEqual({allow:true})
    current = {...current, policySettings:{prependPlugins:['sec-default@builtin']}}
    settingsChangeDetector.notifyChange('policySettings')
    await host.bind(binding)
    expect(await decision()).toEqual({deny:'core'})
    current = {...settings(), subscriptionType:'pro'}
    settingsChangeDetector.notifyChange('policySettings')
    await host.bind(binding)
    expect(await decision()).toEqual({allow:true})
    expect(await host.runtime!.dispatch('tool.call',input,core)).toEqual({result:1})
  })

  test('independent hosts have independent activations even with identical bindings', async () => {
    const declaration = await plugin(
      `let calls = 0; export function register(on) { on('tool.call', () => ({ result: ++calls })); }`,
    )
    const one = session({ loadPlugins: async () => [declaration] })
    const two = session({ loadPlugins: async () => [declaration] })
    await Promise.all([one.bind(binding), two.bind(binding)])
    expect(one.runtime).not.toBe(two.runtime)
    expect(await one.runtime!.dispatch('tool.call', input, core)).toEqual({
      result: 1,
    })
    expect(await one.runtime!.dispatch('tool.call', input, core)).toEqual({
      result: 2,
    })
    expect(await two.runtime!.dispatch('tool.call', input, core)).toEqual({
      result: 1,
    })
    const secondRuntime = two.runtime!
    await one.dispose()
    await disposeModsHosts()
    expect(two.runtime).toBeUndefined()
    await expect(
      secondRuntime.dispatch('tool.call', input, core),
    ).rejects.toThrow('disposed')
  })

  test('session.end keeps the ending binding and runs once per bound session before disposal', async () => {
    const declaration = await plugin(`export function register(on) {
      on('session.end', async ($, e, next) => {
        const events = JSON.parse(await $.fs.read('./ended.json'));
        const result = await next(e);
        events.push({input:e, current:await $.session.id(), result});
        await $.fs.write('./ended.json', JSON.stringify(events));
        return result;
      });
    }`)
    const path = join(declaration.path, 'ended.json')
    await writeFile(path, '[]')
    const events: string[] = []
    const host = session({ loadPlugins: async () => [declaration], onDiagnostic: event => events.push(event.message) })
    await host.bind({ ...binding, cwd: declaration.path })
    expect(events).toEqual([])
    await Promise.all([
      host.runtime!.endSession('clear'),
      host.runtime!.endSession('clear'),
    ])
    await host.runtime!.endSession('other')
    const cleared = { ...binding, cwd: declaration.path, sessionId: 'cleared' }
    await host.bind(cleared)
    await shutdown.endModsSessions('resume', 1500, 'unrelated')
    expect(JSON.parse(await readFile(path, 'utf8'))).toHaveLength(1)
    await shutdown.endModsSessions('resume', 1500, 'cleared')
    await host.bind({ ...cleared, sessionId: 'first' })
    await shutdown.endModsSessions('other')
    await disposeModsHosts()
    expect(host.runtime).toBeUndefined()
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([
      {input:{reason:'clear', sessionId:'first', resume:{id:'first'}}, current:'first', result:{sessionId:'first'}},
      {input:{reason:'resume', sessionId:'cleared', resume:{id:'cleared'}}, current:'cleared', result:{sessionId:'cleared'}},
      {input:{reason:'other', sessionId:'first', resume:{id:'first'}}, current:'first', result:{sessionId:'first'}},
    ])
    expect(events).toEqual([])
  })

  test('same-ID resume starts a new end lifetime without reactivating the plugin', async () => {
    const declaration = await plugin(`let starts=0; export function register(on) {
      on('session.start', ($,e,next) => {starts++;return next(e)});
      on('session.end', async ($,e,next) => {
        const events=JSON.parse(await $.fs.read('./ended.json'));
        events.push({reason:e.reason,id:await $.session.id(),starts});
        await $.fs.write('./ended.json',JSON.stringify(events));
        return next(e);
      });
    }`)
    const path = join(declaration.path,'ended.json')
    await writeFile(path,'[]')
    const host = session({loadPlugins:async()=>[declaration]})
    const same = {...binding,cwd:declaration.path}
    await host.bind(same)
    await host.runtime!.endSession('resume')
    await host.bind({...same})
    await host.runtime!.endSession('other')
    await host.runtime!.endSession('other')
    expect(JSON.parse(await readFile(path,'utf8'))).toEqual([
      {reason:'resume',id:'first',starts:1},
      {reason:'other',id:'first',starts:1},
    ])
  })

  test('session.end rejects rewritten engine fields inside the recovery boundary', async () => {
    const declaration = await plugin(`export function register(on) {
      on('session.end', async ($, e, next) => {
        const failures = [];
        for (const changed of [{...e,reason:'logout'}, {...e,sessionId:'fake'}, {...e,resume:{id:'fake'}}]) {
          try { await next(changed) } catch (error) { failures.push(error.message) }
        }
        await $.fs.write('./pinned.json', JSON.stringify(failures));
        return next(e);
      });
      on('session.end', () => ({invalid:true})).catch(async ($, e, next) => {
        await $.fs.write('./caught', next.error.message);
        return next(e);
      });
    }`)
    const events: string[] = []
    const host = session({ loadPlugins: async () => [declaration], onDiagnostic: event => events.push(event.message) })
    await host.bind({ ...binding, cwd: declaration.path })
    expect(events).toEqual([])
    await host.runtime!.endSession('clear')
    const failures = JSON.parse(await readFile(join(declaration.path, 'pinned.json'), 'utf8'))
    expect(failures).toEqual(['reason','sessionId','resume'].map(key => `Mod fixture cannot rewrite ${key} for session.end`))
    expect(await readFile(join(declaration.path, 'caught'), 'utf8')).toBe('session.end must return sessionId')
    expect(events).toEqual(['session.end must return sessionId'])
  })

  test('session.end timeout cancels the Worker invocation without preventing host disposal', async () => {
    const declaration = await plugin(`export function register(on) {
      on('session.end', async ($, e, next) => {
        await $.fs.write('./entered', e.sessionId);
        await $.clock.sleep(10000);
        await $.fs.write('./late', 'must not run');
        return next(e);
      });
    }`)
    const events: string[] = []
    const host = session({ loadPlugins: async () => [declaration], onDiagnostic: event => events.push(event.stage) })
    await host.bind({ ...binding, cwd: declaration.path })
    expect(events).toEqual([])
    await shutdown.endModsSessions('other', 150)
    expect(await readFile(join(declaration.path, 'entered'), 'utf8')).toBe('first')
    await disposeModsHosts()
    expect(host.runtime).toBeUndefined()
    expect(events).toContain('session.end')
    expect(await Bun.file(join(declaration.path, 'late')).exists()).toBe(false)
  })

  test('explicit plugin refresh awaits activation, keeps old on technical failure and removes disabled', async () => {
    const declaration = await plugin()
    const events: string[] = []
    const host = session({
      loadPlugins: async () => [declaration],
      onDiagnostic: event => events.push(event.stage),
    })
    await host.bind(binding)
    await writeFile(
      join(declaration.path, 'register.ts'),
      `let started = false; export function register(on) {
      on('session.start', async ($, e, next) => { await $.clock.sleep(15); started = true; return next(e) });
      on('tool.call', () => ({ result: started ? 'new' : 'too-early' }));
    }`,
    )
    await refreshPluginRuntimes([declaration])
    expect(await host.runtime!.dispatch('tool.call', input, core)).toEqual({
      result: 'new',
    })
    await writeFile(
      join(declaration.path, 'register.ts'),
      'export function register(',
    )
    await host.refresh([declaration])
    expect(events).toContain('reload')
    expect(await host.runtime!.dispatch('tool.call', input, core)).toEqual({
      result: 'new',
    })
    await refreshPluginRuntimes([])
    expect(await host.runtime!.dispatch('tool.call', input, core)).toEqual({
      result: 'core',
    })
  })

  test('settings refresh fingerprint retains only a bounded digest of relevant settings', async () => {
    // Inspect the private fingerprint without adding a production test export.
    const source = await readFile(new URL('./session.ts', import.meta.url), 'utf8')
    const body = source.match(/function relevantSettings\(settings: PrepareModPluginsSettings\): string \{([\s\S]*?)\n {2}\}/)?.[1]
    expect(body).toBeDefined()
    const fingerprint = new Function('createHash', 'settings', 'options', body!)
    const key = (value: PrepareModPluginsSettings, disabled?: string): string =>
      fingerprint(createHash, value, { getDisabledReason: () => disabled })
    const secret = 'synthetic-sensitive-option'
    const large = 'synthetic-large-option'.repeat(10_000)
    const current: PrepareModPluginsSettings = {
      ...settings(),
      userSettings: {
        pluginConfigs: { 'fixture@inline': { options: { secret, large } } },
      },
    }
    const original = key(current)
    expect(original).toMatch(/^[a-f0-9]{64}$/)
    expect(original).not.toContain(secret)
    expect(original).not.toContain(large)
    expect(key(structuredClone(current))).toBe(original)
    expect(key({ ...current, userSettings: { ...current.userSettings, model: 'unrelated' } })).toBe(original)
    const changed = structuredClone(current)
    changed.userSettings!.pluginConfigs!['fixture@inline']!.options!.secret = 'changed'
    expect(key(changed)).not.toBe(original)
    expect(key({ ...current, hookPolicy: { managedOnly: true, allDisabled: false } })).not.toBe(original)
    expect(key(current, 'disabled')).not.toBe(original)
  })

  test('trusted options changes refresh; unrelated settings do not rescan plugins; policy removes old', async () => {
    const declaration = await plugin(
      `export function register(on, options) { on('tool.call', () => ({ result: options.label })); }`,
    )
    declaration.manifest.userConfig = {
      label: {
        type: 'string',
        title: 'Label',
        description: 'Fixture label',
        default: 'one',
      },
    }
    let current: PrepareModPluginsSettings = settings()
    let loads = 0
    const host = session({
      getSettings: () => current,
      loadPlugins: async () => {
        loads++
        return [declaration]
      },
    })
    await host.bind(binding)
    expect(await host.runtime!.dispatch('tool.call', input, core)).toEqual({
      result: 'one',
    })
    current = structuredClone(current)
    settingsChangeDetector.notifyChange('userSettings')
    await host.bind(binding)
    expect(loads).toBe(1)
    current = { ...current, userSettings: { model: 'unrelated' } }
    settingsChangeDetector.notifyChange('userSettings')
    await host.bind(binding)
    expect(loads).toBe(1)
    current = {
      ...current,
      userSettings: {
        pluginConfigs: { 'fixture@inline': { options: { label: 'two' } } },
      },
    }
    settingsChangeDetector.notifyChange('userSettings')
    await host.bind(binding)
    expect(await host.runtime!.dispatch('tool.call', input, core)).toEqual({
      result: 'two',
    })
    expect(loads).toBe(2)
    current = structuredClone(current)
    settingsChangeDetector.notifyChange('userSettings')
    await host.bind(binding)
    expect(loads).toBe(2)
    current = { ...current, policySettings: { disableAllHooks: true } }
    settingsChangeDetector.notifyChange('policySettings')
    await host.bind(binding)
    expect(host.runtime!.hasHooks('tool.call')).toBe(false)
  })

  test('saved sensitive numbers, booleans and string arrays retain their declared types in register', async () => {
    let stored = {}
    spyOn(secureStorage, 'getSecureStorage').mockReturnValue({
      read: () => structuredClone(stored),
      update: (value: object) => { stored = structuredClone(value); return {success:true} },
    } as unknown as ReturnType<typeof secureStorage.getSecureStorage>)
    const readSettings = spyOn(settingsStorage, 'getSettings_DEPRECATED').mockReturnValue({})
    cleanups.push(() => readSettings.mockRestore())
    const declaration = await plugin(`export function register(on, options) { on('tool.call', () => ({result:options})); }`)
    declaration.manifest.userConfig = {
      count:{type:'number',title:'Count',description:'',sensitive:true,required:true},
      enabled:{type:'boolean',title:'Enabled',description:'',sensitive:true,required:true},
      labels:{type:'string',title:'Labels',description:'',sensitive:true,multiple:true,required:true},
    }
    const values = {count:0,enabled:false,labels:['fake,first','fake-second']}
    savePluginOptions(declaration.source, values, declaration.manifest.userConfig)
    const events: unknown[] = []
    const host = session({loadPlugins:async () => [declaration],onDiagnostic:event => events.push(event)})
    await host.bind(binding)
    expect(events).toEqual([])
    expect(await host.runtime!.dispatch('tool.call',input,core)).toEqual({result:values})
  })

  test('saving only a sensitive token reloads register options before the next prompt', async () => {
    const first = 'fake-sensitive-token-one'
    const second = 'fake-sensitive-token-two'
    let stored = { pluginSecrets: { 'fixture@inline': { token: first } } }
    const read = spyOn(secureStorage, 'getSecureStorage').mockReturnValue({
      read: () => structuredClone(stored),
      update: (value: typeof stored) => { stored = structuredClone(value); return { success: true } },
    } as unknown as ReturnType<typeof secureStorage.getSecureStorage>)
    const readSettings = spyOn(settingsStorage, 'getSettings_DEPRECATED').mockReturnValue({})
    const writeSettings = spyOn(settingsStorage, 'updateSettingsForSource').mockImplementation(() => {
      throw new Error('a token-only save must not write settings')
    })
    clearPluginOptionsCache()
    cleanups.push(() => { read.mockRestore(); readSettings.mockRestore(); writeSettings.mockRestore(); clearPluginOptionsCache() })
    const declaration = await plugin(`let calls=0; export function register(on, options) {
      on('tool.call', ($, e) => ({result:{matches:options.token === e.token, mode:options.mode, calls:++calls}}));
    }`)
    declaration.manifest.userConfig = {
      token: {type:'string', title:'Token', description:'', sensitive:true, required:true},
      mode: {type:'string', title:'Mode', description:'', default:'safe'},
    }
    const events: unknown[] = []
    const host = session({loadPlugins:async () => [declaration], onDiagnostic:event => events.push(event)})
    await host.bind(binding)
    expect(events).toEqual([])
    expect(host.runtime).toBeDefined()
    expect(await host.runtime!.dispatch('tool.call', {...input, token:first}, core)).toEqual({result:{matches:true, mode:'safe', calls:1}})
    await host.refresh()
    expect(await host.runtime!.dispatch('tool.call', {...input, token:first}, core)).toEqual({result:{matches:true, mode:'safe', calls:2}})
    const previous = host.runtime!.capture()
    try {
      savePluginOptions(declaration.source, {token:second}, declaration.manifest.userConfig)
      await host.bind(binding)
      expect(await host.runtime!.dispatch('tool.call', {...input, token:second}, core)).toEqual({result:{matches:true, mode:'safe', calls:1}})
      expect(await previous.dispatch('tool.call', {...input, token:first}, core)).toEqual({result:{matches:true, mode:'safe', calls:3}})
    } finally { previous.release() }
    savePluginOptions(declaration.source, {token:second}, declaration.manifest.userConfig)
    await host.bind(binding)
    expect(await host.runtime!.dispatch('tool.call', {...input, token:second}, core)).toEqual({result:{matches:true, mode:'safe', calls:2}})
    expect(events).toEqual([])
    expect(writeSettings).not.toHaveBeenCalled()
  })

  test('missing required secrets block evaluation, remove old hooks and recover after save', async () => {
    let stored: {pluginSecrets?: Record<string, Record<string, string>>} = {}
    spyOn(secureStorage, 'getSecureStorage').mockReturnValue({
      read: () => structuredClone(stored),
      update: (value: typeof stored) => { stored = structuredClone(value); return {success:true} },
    } as unknown as ReturnType<typeof secureStorage.getSecureStorage>)
    const readSettings = spyOn(settingsStorage, 'getSettings_DEPRECATED').mockReturnValue({})
    cleanups.push(() => readSettings.mockRestore())
    const declaration = await plugin(`throw Error('module must not evaluate without required secret'); export function register(on) {}`)
    declaration.manifest.userConfig = {token:{type:'string',title:'Token',description:'',sensitive:true,required:true}}
    let creates = 0
    const events: string[] = []
    const host = session({
      loadPlugins:async () => [declaration],
      onDiagnostic:event => events.push(event.stage),
      createRuntime:options => { creates++; return createModsRuntime(options) },
    })
    await host.bind(binding)
    expect(creates).toBe(0)
    expect(events).toEqual(['options'])
    await writeFile(join(declaration.path,'register.ts'), `export function register(on, options) {
      on('tool.call', ($, e) => ({result:options.token === e.token}));
    }`)
    savePluginOptions(declaration.source, {token:'fake-recovery-token'}, declaration.manifest.userConfig)
    await host.bind(binding)
    expect(await host.runtime!.dispatch('tool.call',{...input,token:'fake-recovery-token'},core)).toEqual({result:true})
    stored = {}
    clearPluginOptionsCache()
    await host.refresh()
    expect(host.runtime!.hasHooks('tool.call')).toBe(false)
    savePluginOptions(declaration.source, {token:'fake-recovered-token'}, declaration.manifest.userConfig)
    await host.bind(binding)
    expect(await host.runtime!.dispatch('tool.call',{...input,token:'fake-recovered-token'},core)).toEqual({result:true})
    expect(creates).toBe(1)
    expect(events).toEqual(['options','options'])
  })

  test('secure storage read failure retains activation and permits a sanitized explicit retry', async () => {
    let fail = false
    const secret = 'fake-read-error-secret'
    spyOn(secureStorage, 'getSecureStorage').mockReturnValue({
      read: () => {
        if (fail) throw Error(`backend error ${secret}`)
        return {pluginSecrets:{'fixture@inline':{token:secret}}}
      },
    } as unknown as ReturnType<typeof secureStorage.getSecureStorage>)
    const declaration = await plugin(`export function register(on, options) {
      on('tool.call', ($, e) => ({result:options.token === e.token}));
    }`)
    declaration.manifest.userConfig = {token:{type:'string',title:'Token',description:'',sensitive:true,required:true}}
    const events: unknown[] = []
    const host = session({loadPlugins:async () => [declaration],onDiagnostic:event => events.push(event)})
    await host.bind(binding)
    fail = true
    clearPluginOptionsCache()
    await expect(host.refresh()).rejects.toThrow('Unable to read plugin options from secure storage')
    expect(JSON.stringify(events)).not.toContain(secret)
    expect(await host.runtime!.dispatch('tool.call',{...input,token:secret},core)).toEqual({result:true})
    fail = false
    await host.refresh()
    expect(await host.runtime!.dispatch('tool.call',{...input,token:secret},core)).toEqual({result:true})
  })

  test('redacts sensitive register failures from diagnostics and logs across token rotation', async () => {
    const first = 'fake-register-secret-one'
    const second = 'fake-register-secret-two'
    let stored = {pluginSecrets:{'fixture@inline':{token:first}}}
    spyOn(secureStorage, 'getSecureStorage').mockReturnValue({
      read: () => stored,
    } as unknown as ReturnType<typeof secureStorage.getSecureStorage>)
    const declaration = await plugin(`export function register(on, options) {
      throw Error('register rejected ' + options.token);
    }`)
    declaration.manifest.userConfig = {token:{type:'string',title:'Token',description:'',sensitive:true,required:true}}
    const events: unknown[] = []
    const logs: string[] = []
    const stderr = spyOn(process.stderr, 'write').mockImplementation(value => { logs.push(String(value)); return true })
    const logging = spyOn(debug, 'logForDebugging').mockImplementation(value => { logs.push(value) })
    cleanups.push(() => { stderr.mockRestore(); logging.mockRestore() })
    const host = session({loadPlugins:async () => [declaration],onDiagnostic:event => events.push(event)})
    await host.bind(binding)
    stored = {pluginSecrets:{'fixture@inline':{token:second}}}
    clearPluginOptionsCache()
    await host.refresh()
    expect(events).toHaveLength(2)
    expect(JSON.stringify(events)).toContain('[REDACTED]')
    for (const value of [first, second]) {
      expect(JSON.stringify(events)).not.toContain(value)
      expect(logs.join('\n')).not.toContain(value)
    }
  })

  test('tier-only settings changes reseat live modules and policy presence suppresses user ordering', async () => {
    const make = async (name: string) => ({
      ...await plugin(`export function register(on) { on('tool.call', async ($, e, next) => { const result=await next(e); return {result:['${name}', ...result.result]}; }); }`),
      name, manifest: {name}, source: `${name}@inline`, repository: `${name}@inline`,
    })
    const first = await make('first')
    const second = await make('second')
    let current: PrepareModPluginsSettings = settings()
    const host = session({getSettings: () => current, loadPlugins: async () => [first, second]})
    await host.bind(binding)
    const dispatch = () => host.runtime!.dispatch('tool.call', input, async () => ({result:[]}))
    expect(await dispatch()).toEqual({result:['first', 'second']})
    current = {...current, userSettings: {prependPlugins:['second@inline']}}
    settingsChangeDetector.notifyChange('userSettings')
    await host.bind(binding)
    expect(await dispatch()).toEqual({result:['second', 'first']})
    current = {...current, policySettings: {env: {MODS_SYNTHETIC_POLICY:'present'}}}
    settingsChangeDetector.notifyChange('policySettings')
    await host.bind(binding)
    expect(await dispatch()).toEqual({result:['first', 'second']})
    current = {...current, policySettings: {
      enabledPlugins: {'first@inline':true, 'second@inline':true},
      appendPlugins:['first@inline'],
    }}
    settingsChangeDetector.notifyChange('policySettings')
    await host.bind(binding)
    expect(await dispatch()).toEqual({result:['second', 'first']})
    current = {...current, policySettings: {
      enabledPlugins: {'first@inline':true, 'second@inline':true},
      appendPlugins:['second@inline'],
    }}
    settingsChangeDetector.notifyChange('policySettings')
    await host.bind(binding)
    expect(await dispatch()).toEqual({result:['first', 'second']})
  })

  test('managed PreToolUse permits session activation and protects the natural tool entry', async () => {
    const declaration = await plugin(`export function register(on) {
      on('tool.call', () => ({result:{value:'must not escape policy'}}));
      on('classic.PreToolUse', () => ({allow:true}));
    }`)
    const policy = { hooks: { PreToolUse: [{ hooks: [{type:'command' as const,
      command:`printf '%s' '${JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'session managed refusal'}})}'`,
    }] }] } }
    const wasInteractive = getIsInteractive()
    setIsInteractive(false)
    resetSettingsCache()
    resetHooksConfigSnapshot()
    setSessionSettingsCache({settings:{},errors:[]})
    for (const source of ['policySettings','userSettings','projectSettings','localSettings','flagSettings'] as const)
      setCachedSettingsForSource(source,source === 'policySettings' ? policy : {})
    cleanups.push(() => {resetSettingsCache();resetHooksConfigSnapshot();setIsInteractive(wasInteractive)})
    const host = session({loadPlugins:async () => [declaration],getSettings:() => ({...settings(),policySettings:policy})})
    await host.bind(binding)
    expect(host.runtime?.hasHooks('tool.call')).toBe(true)
    let calls=0
    const tool = {name:'SessionPolicyFixture',inputSchema:z.object({value:z.string()}),outputSchema:z.object({value:z.string()}),maxResultSizeChars:Infinity,
      call:async (input:unknown) => {calls++;return {data:input}},
      mapToolResultToToolResultBlockParam:(data:{value:string},id:string) => ({type:'tool_result',tool_use_id:id,content:data.value}),
    } as unknown as Tool
    const context = {mods:host.runtime,options:{tools:[tool],mcpClients:[],isNonInteractiveSession:true},abortController:new AbortController(),messages:[],
      getAppState:() => ({toolPermissionContext:getEmptyToolPermissionContext(),sessionHooks:new Map()}),setAppState:() => {},setInProgressToolUseIDs:() => {},
    } as unknown as ToolUseContext
    const block={type:'tool_use' as const,caller:{type:'direct' as const},id:'session-policy',name:tool.name,input:{value:'original'}}
    const updates=await Array.fromAsync(runToolUse(block,createAssistantMessage({content:[block]}),async () => ({behavior:'allow'}),context))
    expect(JSON.stringify(updates)).toContain('session managed refusal')
    expect(JSON.stringify(updates)).not.toContain('must not escape policy')
    expect(calls).toBe(0)
  })

  test('managed tool policy changes retain Mods without executing or altering classic hooks', async () => {
    const declaration = await plugin()
    let current: PrepareModPluginsSettings = settings()
    const host = session({ getSettings: () => current, loadPlugins: async () => [declaration] })
    await host.bind(binding)
    expect(host.runtime!.hasHooks('tool.call')).toBe(true)
    const hooks = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command' as const, command: 'policy-command-must-not-run' }] }] }
    current = { ...current, policySettings: { hooks } }
    settingsChangeDetector.notifyChange('policySettings')
    await host.bind(binding)
    expect(host.runtime!.hasHooks('tool.call')).toBe(true)
    expect(current.policySettings!.hooks).toBe(hooks)
    current = { ...current, policySettings: null }
    settingsChangeDetector.notifyChange('policySettings')
    await host.bind(binding)
    expect(await host.runtime!.dispatch('tool.call', input, core)).toEqual({ result: 1 })
  })

  test('managed PostToolUse permits activation and rewrites a regular tool final output', async () => {
    const declaration = await plugin(`export function register(on) {
      on('tool.call', async ($, e, next) => next(e));
    }`)
    const policy = { hooks: { PostToolUse: [{ hooks: [{
      type: 'command' as const,
      command: `printf '%s' '${JSON.stringify({ hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedToolOutput: { value: 'managed final' },
      } })}'`,
    }] }] } }
    const wasInteractive = getIsInteractive()
    setIsInteractive(false)
    resetSettingsCache()
    resetHooksConfigSnapshot()
    setSessionSettingsCache({ settings: {}, errors: [] })
    for (const source of ['policySettings', 'userSettings', 'projectSettings', 'localSettings', 'flagSettings'] as const)
      setCachedSettingsForSource(source, source === 'policySettings' ? policy : {})
    cleanups.push(() => { resetSettingsCache(); resetHooksConfigSnapshot(); setIsInteractive(wasInteractive) })
    const host = session({
      loadPlugins: async () => [declaration],
      getSettings: () => ({ ...settings(), policySettings: policy }),
    })
    await host.bind(binding)
    expect(host.runtime?.hasHooks('tool.call')).toBe(true)
    const tool = {
      name: 'SessionPostPolicyFixture',
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ value: z.string() }),
      maxResultSizeChars: Infinity,
      call: async () => ({ data: { value: 'raw' } }),
      mapToolResultToToolResultBlockParam: (data: { value: string }, id: string) => ({
        type: 'tool_result', tool_use_id: id, content: data.value,
      }),
    } as unknown as Tool
    const context = {
      mods: host.runtime,
      options: { tools: [tool], mcpClients: [], isNonInteractiveSession: true },
      abortController: new AbortController(),
      messages: [],
      getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map() }),
      setAppState: () => {},
      setInProgressToolUseIDs: () => {},
    } as unknown as ToolUseContext
    const block = { type: 'tool_use' as const, caller: { type: 'direct' as const }, id: 'session-post-policy', name: tool.name, input: { value: 'original' } }
    const updates = await Array.fromAsync(runToolUse(block, createAssistantMessage({ content: [block] }), async () => ({ behavior: 'allow' }), context))
    expect(JSON.stringify(updates)).toContain('managed final')
    expect(JSON.stringify(updates)).not.toContain('"content":"raw"')
  })

  test('an explicit clear binding is not overwritten by a later declaration refresh', async () => {
    const declaration = await plugin(`let cwd; export function register(on) {
      on('session.start', ($, e, next) => { cwd = e.cwd; return next(e) });
      on('tool.call', () => ({ result: cwd }));
    }`)
    const host = session({ loadPlugins: async () => [declaration] })
    await host.bind(binding)
    await host.runtime!.bind({
      ...binding,
      sessionId: 'cleared',
      cwd: '/cleared',
    })
    await host.refresh([declaration])
    await writeFile(
      join(declaration.path, 'register.ts'),
      `let cwd; export function register(on) {
      on('session.start', ($, e, next) => { cwd = e.cwd; return next(e) });
      on('tool.call', () => ({ result: cwd + ':new' }));
    }`,
    )
    await host.refresh([declaration])
    expect(await host.runtime!.dispatch('tool.call', input, core)).toEqual({
      result: '/cleared:new',
    })
  })

  test('immutable built-in module roots are not watched', async () => {
    const watching = watchEvents()
    const declaration = await plugin()
    declaration.source = 'fixture@builtin'
    declaration.repository = 'fixture@builtin'
    declaration.isBuiltin = true
    const host = session({ loadPlugins: async () => [declaration] })

    await host.bind(binding)

    expect(watching.watch).not.toHaveBeenCalled()
    expect(watching.watchers).toEqual([])
    await host.dispose()
  })

  test('owned import changes reload with polling, idle polls do not reload plugins', async () => {
    const watching = watchEvents()
    const declaration = await plugin(
      `import { value } from './value.ts'; export function register(on) { on('tool.call', () => ({ result: value })); }`,
    )
    await writeFile(
      join(declaration.path, 'value.ts'),
      `export const value = 'old'`,
    )
    let loads = 0
    const refreshed = Promise.withResolvers<void>()
    const host = session({
      loadPlugins: async () => {
        loads++
        if (loads > 1) refreshed.resolve()
        return [declaration]
      },
    })
    await host.bind(binding)
    await watching.ready[0]
    // More than two polling ticks without any filesystem change.
    await Bun.sleep(1100)
    expect(loads).toBe(1)
    await writeFile(
      join(declaration.path, 'value.ts'),
      `export const value = 'new'`,
    )
    await refreshed.promise
    await host.bind(binding)
    expect(await host.runtime!.dispatch('tool.call', input, core)).toEqual({
      result: 'new',
    })
    expect(watching.watchers).toHaveLength(1)
    await host.dispose()
    expect(watching.watchers[0]!.closed).toBe(true)
  }, 10000)

  test('dispose closes watchers before awaiting runtime disposal and is idempotent', async () => {
    const watching = watchEvents()
    const declaration = await plugin()
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    let disposals = 0
    const host = session({
      loadPlugins: async () => [declaration],
      createRuntime: options => {
        const runtime = createModsRuntime(options)
        return {
          ...runtime,
          async dispose() {
            disposals++
            expect(watching.watchers[0]!.closed).toBe(true)
            entered.resolve()
            await finish.promise
            await runtime.dispose()
          },
        }
      },
    })
    await host.bind(binding)
    await watching.ready[0]
    const pending = host.dispose()
    await entered.promise
    expect(host.dispose()).toBe(pending)
    await refreshPluginRuntimes([declaration])
    expect(watching.watchers).toHaveLength(1)
    finish.resolve()
    await pending
    expect(disposals).toBe(1)
  })

  test('a pending plugin load cannot resurrect a disposed host', async () => {
    const declaration = await plugin()
    const entered = Promise.withResolvers<void>()
    const loaded = Promise.withResolvers<readonly LoadedPlugin[]>()
    let creates = 0
    const host = session({
      loadPlugins: () => {
        entered.resolve()
        return loaded.promise
      },
      createRuntime: () => {
        creates++
        throw new Error('unexpected Worker')
      },
    })
    const first = host.bind(binding)
    await entered.promise
    const disposed = host.dispose()
    loaded.resolve([declaration])
    await Promise.all([first, disposed])
    await refreshPluginRuntimes([declaration])
    expect(creates).toBe(0)
  })

  test('watcher replacement cannot resurrect after close awaits during disposal', async () => {
    const first = await plugin()
    const second = await plugin()
    const closing = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    let watches = 0
    const emitter = Object.assign(new EventEmitter(), {
      close: () => {
        entered.resolve()
        return closing.promise
      },
    })
    const watch = spyOn(chokidar, 'watch').mockImplementation(() => {
      watches++
      return emitter as unknown as FSWatcher
    })
    cleanups.push(() => watch.mockRestore())
    const runtime = {
      reconcile: async () => {},
      bind: async () => {},
      dispose: async () => {},
      commands: { subscribe: () => () => {} },
      config: { invalidate: () => {} },
      ui: { subscribe: () => () => {} },
    } as unknown as ModsRuntime
    const host = session({
      loadPlugins: async () => [first],
      createRuntime: () => runtime,
    })
    await host.bind(binding)
    const refresh = host.refresh([second])
    await entered.promise
    const disposed = host.dispose()
    closing.resolve()
    await Promise.all([refresh, disposed])
    expect(watches).toBe(1)
  })

  test('CLI wiring keeps clear as a bind and shutdown ordered before parallel cleanup', async () => {
    const clear = await readFile(
      new URL('../../commands/clear/conversation.ts', import.meta.url),
      'utf8',
    )
    expect(clear).toContain('if (mods) await mods.bind(')
    expect(clear).not.toContain('mods.dispose(')
    const shutdown = await readFile(
      new URL('../../utils/gracefulShutdown.ts', import.meta.url),
      'utf8',
    )
    const classicEnd = shutdown.indexOf('await executeSessionEndHooks(reason,')
    const disposal = shutdown.indexOf('await disposeModsHosts()')
    expect(classicEnd).toBeGreaterThan(-1)
    expect(disposal).toBeGreaterThan(classicEnd)
    expect(disposal).toBeLessThan(shutdown.indexOf('await runCleanupFunctions()'))
    const refresh = await readFile(
      new URL('../../utils/plugins/refresh.ts', import.meta.url),
      'utf8',
    )
    expect(refresh).toContain('await refreshPluginRuntimes(enabled)')
  })
})
