import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import chokidar, { type FSWatcher } from 'chokidar'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LoadedPlugin } from '../../types/plugin.js'
import { disposeModsHosts } from '../../utils/gracefulShutdown.js'
import { refreshPluginRuntimes } from '../../utils/plugins/cacheUtils.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import type { PrepareModPluginsSettings } from './plugins.js'
import { createModsRuntime, type ModsRuntime } from './runtime.js'
import {
  createModsSession,
  type ModsSession,
  type ModsSessionOptions,
} from './session.js'

const cleanups: (() => Promise<unknown> | void)[] = []
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
    current = { ...current, policySettings: { disableAllHooks: true } }
    settingsChangeDetector.notifyChange('policySettings')
    await host.bind(binding)
    expect(host.runtime!.hasHooks('tool.call')).toBe(false)
  })

  test('managed tool policy changes withdraw Mods without executing or altering classic hooks', async () => {
    const declaration = await plugin()
    let current: PrepareModPluginsSettings = settings()
    const host = session({ getSettings: () => current, loadPlugins: async () => [declaration] })
    await host.bind(binding)
    expect(host.runtime!.hasHooks('tool.call')).toBe(true)
    const hooks = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command' as const, command: 'policy-command-must-not-run' }] }] }
    current = { ...current, policySettings: { hooks } }
    settingsChangeDetector.notifyChange('policySettings')
    await host.bind(binding)
    expect(host.runtime!.hasHooks('tool.call')).toBe(false)
    expect(current.policySettings!.hooks).toBe(hooks)
    current = { ...current, policySettings: null }
    settingsChangeDetector.notifyChange('policySettings')
    await host.bind(binding)
    expect(await host.runtime!.dispatch('tool.call', input, core)).toEqual({ result: 1 })
  })

  test('managed PostToolUse blocks evaluation before any Worker is created', async () => {
    const declaration = await plugin('throw Error("must not evaluate"); export function register(on) {}')
    const events: string[] = []
    const host = session({
      loadPlugins: async () => [declaration],
      getSettings: () => ({ ...settings(), policySettings: { hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'policy-command-must-not-run' }] }] } } }),
      createRuntime: () => { throw Error('must not create Worker') },
      onDiagnostic: event => events.push(event.message),
    })
    await host.bind(binding)
    expect(host.runtime).toBeUndefined()
    expect(events.some(message => message.includes('managed tool hooks'))).toBe(true)
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
    expect(shutdown.indexOf('await disposeModsHosts()')).toBeLessThan(
      shutdown.indexOf('await runCleanupFunctions()'),
    )
    const refresh = await readFile(
      new URL('../../utils/plugins/refresh.ts', import.meta.url),
      'utf8',
    )
    expect(refresh).toContain('await refreshPluginRuntimes(enabled)')
  })
})
