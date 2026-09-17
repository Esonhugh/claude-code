import { expect, mock, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppState } from '../../state/AppState.js'

const childKey = 'CLAUDE_SETTINGS_CHANGE_TEST'
const scenarios: Record<
  string,
  (h: Awaited<ReturnType<typeof harness>>) => Promise<void>
> = {
  async 'real reload refreshes all settings caches without plugin settings base'(
    h,
  ) {
    const bootstrap = await import('../../bootstrap/state.js')
    const plugin = join(h.root, 'plugin')
    mkdirSync(join(plugin, '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(plugin, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'settings-fixture',
        version: '1.0.0',
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] },
      }),
    )
    bootstrap.setInlinePlugins([plugin])
    const { refreshActivePlugins } = await import('../plugins/refresh.js')
    const { subscribePluginRefresh } = await import('../plugins/cacheUtils.js')
    const { createBaseHookInput, getMatchingHooks } =
      await import('../hooks.js')
    const stopInput = {
      ...createBaseHookInput(),
      hook_event_name: 'Stop' as const,
      stop_hook_active: false,
    }
    let state = {
      plugins: {
        enabled: [],
        disabled: [],
        commands: [],
        errors: [],
        needsRefresh: true,
      },
      mcp: { pluginReconnectKey: 0 },
      agentDefinitions: { allAgents: [], activeAgents: [] },
    } as unknown as AppState
    const seen: boolean[] = []
    let activation = Promise.withResolvers<void>()
    let entered = Promise.withResolvers<void>()
    const unsubscribe = subscribePluginRefresh(async (plugins) => {
      seen.push(h.settings.getInitialSettings().disableAllHooks!)
      if (plugins) {
        entered.resolve()
        await activation.promise
      }
    })
    try {
      expect(h.cache.getPluginSettingsBase()).toBeUndefined()
      for (const value of [false, true]) {
        h.write({ disableAllHooks: value })
        seen.length = 0
        activation = Promise.withResolvers<void>()
        entered = Promise.withResolvers<void>()
        let completed = false
        const refreshing = refreshActivePlugins((update) => {
          state = update(state)
        }).then((result) => {
          completed = true
          return result
        })
        await entered.promise
        await Promise.resolve()
        expect(completed).toBe(false)
        activation.resolve()
        const result = await refreshing
        expect(result.enabled_count).toBe(1)
        expect(result.error_count).toBe(0)
        expect(h.cache.getPluginSettingsBase()).toBeUndefined()
        expect(h.settings.getInitialSettings().disableAllHooks).toBe(value)
        expect(
          h.settings.getSettingsForSource('userSettings')!.disableAllHooks,
        ).toBe(value)
        expect(
          h.settings.parseSettingsFile(h.path).settings!.disableAllHooks,
        ).toBe(value)
        expect(seen.length).toBeGreaterThan(0)
        expect(seen.every((gate) => gate === value)).toBe(true)
        const activeHooks = await getMatchingHooks(
          undefined,
          bootstrap.getSessionId(),
          'Stop',
          stopInput,
        )
        expect(
          activeHooks.filter((hook) => hook.pluginRoot === plugin),
        ).toHaveLength(value ? 0 : 1)
      }
    } finally {
      unsubscribe()
    }
  },
  async 'block survives derived resets and reload until a new candidate is allowed'(
    h,
  ) {
    h.review(async () => true)
    await h.detector.initialize()
    await h.ready()
    h.write({ disableAllHooks: false })
    await h.event('change')
    await h.reviewed()
    expect(h.notifications()).toBe(0)
    h.cache.resetSettingsCache()
    expect(h.settings.getInitialSettings().disableAllHooks).toBe(true)
    expect(
      h.settings.getSettingsForSource('userSettings')!.disableAllHooks,
    ).toBe(true)
    expect(h.settings.parseSettingsFile(h.path).settings!.disableAllHooks).toBe(
      true,
    )
    const { refreshActivePlugins } = await import('../plugins/refresh.js')
    await refreshActivePlugins(() => {})
    expect(h.settings.getInitialSettings().disableAllHooks).toBe(true)
    h.review(async () => false)
    const changed = h.nextChange()
    h.write({ disableAllHooks: false, model: 'allowed' })
    await h.event('change')
    await changed
    expect(h.settings.getInitialSettings().disableAllHooks).toBe(false)
    expect(h.reviews.every((r) => r.effective === true)).toBe(true)
  },
  async 'ConfigChange executes old effective settings hooks before disabling them'(
    h,
  ) {
    h.write({
      disableAllHooks: false,
      hooks: {
        ConfigChange: [{ hooks: [{ type: 'command', command: 'exit 2' }] }],
      },
    })
    h.cache.resetSettingsCache()
    expect(h.settings.getInitialSettings().disableAllHooks).toBe(false)
    h.write({ disableAllHooks: true })
    await h.detector.refreshSettings()
    h.cache.resetSettingsCache()
    expect(h.settings.getInitialSettings().disableAllHooks).toBe(false)
    expect(h.settings.getInitialSettings().hooks?.ConfigChange).toHaveLength(1)
    expect(h.notifications()).toBe(0)
  },
  async 'explicit retry may approve the same previously blocked bytes'(h) {
    h.review(async () => true)
    h.write({ disableAllHooks: false })
    await h.detector.refreshSettings()
    expect(h.settings.getInitialSettings().disableAllHooks).toBe(true)
    h.review(async () => false)
    await h.detector.refreshSettings()
    expect(h.reviews).toHaveLength(2)
    expect(h.settings.getInitialSettings().disableAllHooks).toBe(false)
  },
  async 'approval for A never publishes B and concurrent reload waits for review'(
    h,
  ) {
    const entered = Promise.withResolvers<void>()
    const approval = Promise.withResolvers<boolean>()
    h.review(async () => {
      if (h.reviews.length === 1) {
        entered.resolve()
        return approval.promise
      }
      return true
    })
    h.write({ disableAllHooks: false, model: 'A' })
    const refresh = h.detector.refreshSettings()
    await entered.promise
    h.cache.resetSettingsCache()
    expect(h.settings.getInitialSettings().disableAllHooks).toBe(true)
    h.write({ disableAllHooks: false, model: 'B' })
    const concurrent = h.detector.refreshSettings()
    approval.resolve(false)
    await Promise.all([refresh, concurrent])
    expect(h.reviews).toHaveLength(2)
    expect(h.notifications()).toBe(0)
    expect(h.settings.getInitialSettings().disableAllHooks).toBe(true)
    expect(h.settings.getInitialSettings().model).toBeUndefined()
  },
  async 'dispose prevents an in-flight approval from notifying or publishing'(
    h,
  ) {
    const entered = Promise.withResolvers<void>()
    const approval = Promise.withResolvers<boolean>()
    h.review(async () => {
      entered.resolve()
      return approval.promise
    })
    h.write({ disableAllHooks: false })
    const refresh = h.detector.refreshSettings()
    await entered.promise
    await h.detector.dispose()
    // A late subscriber must not receive the abandoned operation either.
    let lateNotifications = 0
    h.detector.subscribe(() => {
      lateNotifications++
    })
    approval.resolve(false)
    await refresh
    expect(h.notifications()).toBe(0)
    expect(lateNotifications).toBe(0)
    h.cache.resetSettingsCache()
    expect(h.settings.getInitialSettings().disableAllHooks).toBe(true)
  },
  async 'dispose during initialization does not open a late native watcher'(h) {
    const initializing = h.detector.initialize()
    await h.detector.dispose()
    await initializing
    expect(h.watcher()).toBeUndefined()
    expect(h.notifications()).toBe(0)
  },
  async 'internal writes during review do not expose the next external candidate'(
    h,
  ) {
    const entered = Promise.withResolvers<void>()
    const approval = Promise.withResolvers<boolean>()
    h.review(async () => {
      if (h.reviews.length === 1) {
        entered.resolve()
        return approval.promise
      }
      h.cache.resetSettingsCache()
      expect(h.settings.getInitialSettings().model).toBe('internal')
      return true
    })
    h.write({ disableAllHooks: false, model: 'A' })
    const refresh = h.detector.refreshSettings()
    await entered.promise
    expect(
      h.settings.updateSettingsForSource('userSettings', { model: 'internal' })
        .error,
    ).toBeNull()
    h.write({ disableAllHooks: false, model: 'B' })
    approval.resolve(false)
    await refresh
    expect(h.reviews).toHaveLength(2)
    expect(h.settings.getInitialSettings().model).toBe('internal')
    expect(h.settings.getInitialSettings().disableAllHooks).toBe(true)
    expect(h.notifications()).toBe(0)
  },
  async 'real policy ConfigChange audits but cannot block managed candidates'(
    h,
  ) {
    h.review(async () => true)
    h.write({ model: 'managed' }, join(h.managed, 'managed-settings.json'))
    await h.detector.refreshSettings()
    expect(h.reviews).toHaveLength(1)
    expect(h.reviews[0]!.source).toBe('policy_settings')
    expect(h.notifications()).toBe(1)
    expect(h.settings.getInitialSettings().model).toBe('managed')
  },
  async 'internal echoes and duplicate callbacks do not hide a coalesced external write'(
    h,
  ) {
    await h.detector.initialize()
    await h.ready()
    expect(
      h.settings.updateSettingsForSource('userSettings', { model: 'internal' })
        .error,
    ).toBeNull()
    await h.event('change')
    await h.event('change')
    expect(h.reviews).toHaveLength(0)
    expect(h.notifications()).toBe(0)
    expect(
      h.settings.updateSettingsForSource('userSettings', {
        model: 'internal-2',
      }).error,
    ).toBeNull()
    h.write({ disableAllHooks: false, model: 'external' })
    await h.event('change')
    await h.event('change')
    expect(h.reviews).toHaveLength(1)
    expect(h.notifications()).toBe(1)
    expect(h.settings.getInitialSettings().model).toBe('external')
  },
  async 'failed internal writes leave no echo marker and do not mutate effective settings'(
    h,
  ) {
    const file = await import('../file.js')
    const write = file.writeFileSyncAndFlush_DEPRECATED
    mock.module('../file.js', () => ({
      ...file,
      writeFileSyncAndFlush_DEPRECATED: () => {
        throw new Error('fixture write failed')
      },
    }))
    expect(
      h.settings.updateSettingsForSource('userSettings', { model: 'failed' })
        .error,
    ).not.toBeNull()
    mock.module('../file.js', () => ({
      ...file,
      writeFileSyncAndFlush_DEPRECATED: write,
    }))
    expect(h.settings.getInitialSettings().model).toBeUndefined()
    // Use precisely the bytes the failed write would have produced.
    writeFileSync(
      h.path,
      JSON.stringify({ disableAllHooks: true, model: 'failed' }, null, 2) +
        '\n',
    )
    await h.detector.refreshSettings()
    expect(h.reviews).toHaveLength(1)
    expect(h.notifications()).toBe(1)
  },
  async 'an internal update cannot import a blocked newly-created settings file'(
    h,
  ) {
    const projectPath = join(h.root, '.claude', 'settings.json')
    h.review(async () => true)
    h.write({ disableAllHooks: false, model: 'blocked' }, projectPath)
    await h.detector.refreshSettings()
    expect(h.settings.getSettingsForSource('projectSettings')).toBeNull()
    expect(
      h.settings.updateSettingsForSource('projectSettings', {
        model: 'internal',
      }).error,
    ).toBeNull()
    expect(JSON.parse(readFileSync(projectPath, 'utf8'))).toEqual({
      model: 'internal',
    })
    expect(h.settings.getInitialSettings().disableAllHooks).toBe(true)
  },
  async 'native realpath alias writes reach the configured settings path'(h) {
    await h.detector.initialize()
    await h.ready()
    const changed = h.nextChange()
    h.write({ disableAllHooks: false }, realpathSync(h.path))
    await changed
    expect(h.reviews[0]!.path).toBe(h.path)
    expect(h.settings.getInitialSettings().disableAllHooks).toBe(false)
  },
  async 'internal updates merge accepted values rather than blocked candidates'(
    h,
  ) {
    h.review(async () => true)
    h.write({ disableAllHooks: false, model: 'blocked' })
    await h.detector.refreshSettings()
    expect(
      h.settings.updateSettingsForSource('userSettings', { model: 'internal' })
        .error,
    ).toBeNull()
    expect(h.read()).toEqual({ disableAllHooks: true, model: 'internal' })
    await h.detector.refreshSettings()
    expect(h.reviews).toHaveLength(1)
    expect(h.settings.getInitialSettings().disableAllHooks).toBe(true)
    expect(h.settings.getInitialSettings().model).toBe('internal')
  },
  async 'delete and recreate grace publishes only the replacement and real deletion is reviewed'(
    h,
  ) {
    await h.detector.initialize()
    await h.ready()
    rmSync(h.path)
    await h.event('unlink')
    h.write({ disableAllHooks: false })
    await h.event('add')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(h.reviews).toHaveLength(1)
    expect(h.notifications()).toBe(1)
    const changed = h.nextChange()
    rmSync(h.path)
    await h.event('unlink')
    await changed
    expect(h.settings.getInitialSettings().disableAllHooks).toBeUndefined()
    expect(h.reviews).toHaveLength(2)
    expect(h.notifications()).toBe(2)
  },
  async 'native symlink and realpath writes reach the configured settings path'(
    h,
  ) {
    const target = join(h.root, 'settings-target.json')
    h.write({ disableAllHooks: true }, target)
    rmSync(h.path)
    symlinkSync(target, h.path)
    h.cache.resetSettingsCache()
    h.settings.getInitialSettings()
    await h.detector.initialize()
    await h.ready()
    expect(Object.values(h.watcher().getWatched()).flat()).toContain(
      'settings.json',
    )
    const changed = h.nextChange()
    h.write({ disableAllHooks: false }, realpathSync(h.path))
    await changed
    expect(h.reviews[0]!.path).toBe(h.path)
    expect(h.settings.getInitialSettings().disableAllHooks).toBe(false)
  },
  async 'external writes without internal markers use native events'(h) {
    await h.detector.initialize()
    await h.ready()
    const changed = h.nextChange()
    h.write({ disableAllHooks: false })
    await changed
    expect(h.settings.getInitialSettings().disableAllHooks).toBe(false)
    expect(h.reviews).toHaveLength(1)
  },
  async 'expired internal markers cannot suppress a later matching write'(h) {
    const {
      clearInternalWrites,
      consumeInternalWrite,
      markInternalWrite,
      settingsContentIdentity,
    } = await import('./internalWrites.js')
    const realNow = Date.now
    let now = realNow()
    Date.now = () => now
    try {
      markInternalWrite(h.path, 'old')
      now += 5001
      expect(
        consumeInternalWrite(h.path, settingsContentIdentity('old'), 5000),
      ).toBe(false)
      markInternalWrite(h.path, 'A\r\n')
      expect(
        consumeInternalWrite(h.path, settingsContentIdentity('A\n'), 5000),
      ).toBe(false)
      markInternalWrite(h.path, 'echo')
      expect(
        consumeInternalWrite(h.path, settingsContentIdentity('echo'), 5000),
      ).toBe(true)
      expect(
        consumeInternalWrite(h.path, settingsContentIdentity('echo'), 5000),
      ).toBe(false)
    } finally {
      Date.now = realNow
      clearInternalWrites()
    }
  },
  async 'prewatch internal A does not swallow native external B'(h) {
    expect(
      h.settings.updateSettingsForSource('userSettings', {
        disableAllHooks: true,
      }).error,
    ).toBeNull()
    expect(h.settings.getInitialSettings().disableAllHooks).toBe(true)
    await h.detector.initialize()
    await h.ready()
    const changed = h.nextChange()
    h.write({ disableAllHooks: false })
    await changed
    expect(h.settings.getInitialSettings().disableAllHooks).toBe(false)
    expect(h.reviews).toHaveLength(1)
    expect(h.reviews[0]!.effective).toBe(true)
  },
}

if (!process.env[childKey]) {
  for (const name of Object.keys(scenarios)) {
    test(
      name,
      async () => {
        const root = mkdtempSync(join(tmpdir(), 'settings-freshness-'))
        try {
          const child = Bun.spawn(
            [process.execPath, 'test', '--timeout', '12000', import.meta.path],
            {
              cwd: root,
              env: {
                PATH: process.env.PATH,
                HOME: root,
                TMPDIR: root,
                CLAUDE_CONFIG_DIR: join(root, 'config'),
                CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
                DISABLE_AUTOUPDATER: '1',
                [childKey]: name,
              },
              stdout: 'pipe',
              stderr: 'pipe',
            },
          )
          const [code, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ])
          if (code !== 0)
            throw new Error(`${name}: ${code}\n${stdout}\n${stderr}`)
          expect(code).toBe(0)
        } finally {
          rmSync(root, { recursive: true, force: true })
        }
      },
      15000,
    )
  }
} else {
  test(process.env[childKey]!, async () => {
    const h = await harness()
    try {
      await scenarios[process.env[childKey]!]!(h)
    } finally {
      await h.detector.dispose()
    }
  })
}

async function harness() {
  const root = process.env.HOME!
  const config = process.env.CLAUDE_CONFIG_DIR!
  const managed = join(root, 'managed')
  for (const path of [config, managed, join(root, '.claude')])
    mkdirSync(path, { recursive: true })
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
    VERSION: 'test',
  }
  mock.module('./managedPath.js', () => ({
    getManagedFilePath: () => managed,
    getManagedSettingsDropInDir: () => join(managed, 'managed-settings.d'),
  }))
  mock.module('./mdm/settings.js', () => ({
    getMdmSettings: () => ({ settings: {}, errors: [] }),
    getHkcuSettings: () => ({ settings: {}, errors: [] }),
    refreshMdmSettings: async () => ({
      mdm: { settings: {}, errors: [] },
      hkcu: { settings: {}, errors: [] },
    }),
    setMdmSettingsCache: () => {},
  }))
  const chokidar = await import('chokidar')
  const watch = chokidar.default.watch.bind(chokidar.default)
  let watcher: ReturnType<typeof watch>
  let ready: Promise<void>
  mock.module('chokidar', () => ({
    default: {
      watch: (...args: Parameters<typeof watch>) => {
        watcher = watch(...args)
        ready = new Promise((resolve) => watcher.once('ready', resolve))
        return watcher
      },
    },
  }))
  const bootstrap = await import('../../bootstrap/state.js')
  bootstrap.setOriginalCwd(root)
  const settings = await import('./settings.js')
  const cache = await import('./settingsCache.js')
  const reviews: Array<{
    source: string
    path: string
    effective: boolean | undefined
  }> = []
  let review = async (_source: string, _path: string) => false
  bootstrap.setIsInteractive(false)
  bootstrap.registerHookCallbacks({
    ConfigChange: [
      {
        hooks: [
          {
            type: 'callback',
            callback: async (input) => {
              if (input.hook_event_name !== 'ConfigChange')
                throw new Error('Unexpected hook event')
              reviews.push({
                source: input.source,
                path: input.file_path!,
                effective: settings.getInitialSettings().disableAllHooks,
              })
              return (await review(input.source, input.file_path!))
                ? { decision: 'block' }
                : {}
            },
          },
        ],
      },
    ],
  })
  const detector = await import('./changeDetector.js')
  await detector.resetForTesting({
    stabilityThreshold: 40,
    pollInterval: 10,
    deletionGrace: 100,
  })
  const path = join(config, 'settings.json')
  const write = (value: unknown, target = path) =>
    writeFileSync(target, JSON.stringify(value))
  write({ disableAllHooks: true })
  settings.getInitialSettings()
  settings.getSettingsForSource('userSettings')
  settings.parseSettingsFile(path)
  let notifications = 0
  detector.subscribe(() => {
    notifications++
  })
  return {
    root,
    managed,
    path,
    settings,
    cache,
    detector,
    reviews,
    write,
    read: () => JSON.parse(readFileSync(path, 'utf8')),
    ready: () => ready,
    watcher: () => watcher,
    event: async (name: 'change' | 'add' | 'unlink', target = path) => {
      watcher.emit(name, target)
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    reviewed: async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(reviews.length).toBeGreaterThan(0)
    },
    notifications: () => notifications,
    review: (fn: typeof review) => {
      review = fn
    },
    nextChange: () =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          unsubscribe()
          reject(new Error('No settings change after native watcher ready'))
        }, 2500)
        const unsubscribe = detector.subscribe(() => {
          clearTimeout(timer)
          unsubscribe()
          resolve()
        })
      }),
  }
}
