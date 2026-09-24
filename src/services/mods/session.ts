import chokidar, { type FSWatcher } from 'chokidar'
import { sep } from 'node:path'
import type { AppState } from '../../state/AppState.js'
import type { Command } from '../../types/command.js'
import type { LoadedPlugin, PluginError } from '../../types/plugin.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { getSubscriptionType } from '../../utils/auth.js'
import { seatNativeModPlugins } from './native.js'
import { logForDebugging } from '../../utils/debug.js'
import { isShuttingDown, registerModsHostDisposer } from '../../utils/gracefulShutdown.js'
import {
  shouldAllowManagedHooksOnly,
  shouldDisableAllHooksIncludingManaged,
} from '../../utils/hooks/hooksConfigSnapshot.js'
import { subscribePluginRefresh } from '../../utils/plugins/cacheUtils.js'
import {
  clearPluginCache,
  loadAllPluginsCacheOnly,
} from '../../utils/plugins/pluginLoader.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import { getEnabledSettingSources } from '../../utils/settings/constants.js'
import { getMdmSettings } from '../../utils/settings/mdm/settings.js'
import { getSettingsForSource, loadManagedFileSettings } from '../../utils/settings/settings.js'
import { getModPluginOrigin, prepareModPlugins, type PrepareModPluginsSettings } from './plugins.js'
import { getPluginStorageId } from '../../utils/plugins/pluginOptionsStorage.js'
import type { ModUiPane, ModUiPresentation } from './ui.js'
import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import { runModSessionReceive, type SessionReceiveInput, type SessionReceiveResult } from './receiveAdapter.js'
import {
  createModsRuntime,
  type ModBinding,
  type ModDiagnostic,
  type ModHostServices,
  type ModsRuntime,
} from './runtime.js'

export type ModsSessionOptions = {
  /** The CLI supplies this only after its trust gate (print mode has implicit trust). */
  isTrusted: boolean
  getDisabledReason?: () => string | undefined
  loadPlugins?: () => Promise<readonly LoadedPlugin[]>
  getSettings?: () => PrepareModPluginsSettings
  onDiagnostic?: (event: ModDiagnostic) => void
  createRuntime?: typeof createModsRuntime
}

type SetAppState = (updater: (previous: AppState) => AppState) => void

/** One explicit host per CLI session, shared by its main query and forks. */
export function createModsSession(options: ModsSessionOptions) {
  let runtime: ModsRuntime | undefined
  let binding: ModBinding | undefined
  let runtimeBound = false
  const firstBinding = Promise.withResolvers<void>()
  let receiveController = new AbortController()
  let setAppState: SetAppState | undefined
  let initialized = false
  let stopped = false
  let disposal: Promise<void> | undefined
  let queue = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined
  let watcher: FSWatcher | undefined
  let watcherClosing: Promise<void> = Promise.resolve()
  let publishedDiagnostics = false
  let roots: string[] = []
  let unsubscribeSettings: (() => void) | undefined
  let unsubscribePlugins: (() => void) | undefined
  let unregisterShutdown: (() => void) | undefined
  let unregisterCleanup: (() => void) | undefined
  let settingsKey: string | undefined
  let diagnostics: PluginError[] = []
  const reported = new Set<string>()
  const services: ModHostServices = {}
  const uiListeners = new Set<() => void>()
  const emptyPanes: readonly ModUiPane[] = Object.freeze([])
  let unsubscribeUi: (() => void) | undefined
  const ui = {
    getSnapshot: () => runtime?.ui.getSnapshot() ?? emptyPanes,
    subscribe(listener: () => void) {
      uiListeners.add(listener)
      return () => { uiListeners.delete(listener) }
    },
    render: (presentation: ModUiPresentation) => runtime?.ui.render(presentation) ?? Promise.resolve(),
  }
  const commandListeners = new Set<() => void>()
  const emptyCommands: Command[] = []
  let unsubscribeCommands: (() => void) | undefined
  const commands = {
    getSnapshot: () => runtime?.commands.getSnapshot() ?? emptyCommands,
    subscribe(listener: () => void) {
      commandListeners.add(listener)
      return () => { commandListeners.delete(listener) }
    },
    projection: (existing: Command[]) => runtime?.commands.projection(existing) ?? existing,
    describe: (existing: Command[]) => runtime?.commands.describe(existing) ?? Promise.resolve(existing),
  }

  const readSettings =
    options.getSettings ??
    (() => ({
      userSettings: getSettingsForSource('userSettings'),
      flagSettings: getSettingsForSource('flagSettings'),
      policySettings: getSettingsForSource('policySettings'),
      subscriptionType: getSubscriptionType(),
      hasManagedSettings: getMdmSettings().errors.length > 0 || loadManagedFileSettings().errors.length > 0,
      enabledOptionSources: {
        user: getEnabledSettingSources().includes('userSettings'),
        flag: getEnabledSettingSources().includes('flagSettings'),
      },
      hookPolicy: {
        managedOnly: shouldAllowManagedHooksOnly(),
        allDisabled: shouldDisableAllHooksIncludingManaged(),
      },
    }))
  const loadPlugins =
    options.loadPlugins ??
    (async () => (await loadAllPluginsCacheOnly()).enabled)

  function publishDiagnostics() {
    if (!setAppState || (!publishedDiagnostics && diagnostics.length === 0))
      return
    publishedDiagnostics = diagnostics.length > 0
    setAppState(previous => ({
      ...previous,
      plugins: {
        ...previous.plugins,
        errors: [
          ...previous.plugins.errors.filter(
            error => !error.source.startsWith('plugin:mods:'),
          ),
          ...diagnostics,
        ],
      },
    }))
  }

  function diagnostic(event: ModDiagnostic) {
    const key = `${event.plugin}:${event.stage}:${event.message}`
    if (reported.has(key)) return
    reported.add(key)
    // Do not serialize settings, options, event input or stack traces here.
    const text = `[Mods] ${event.plugin} (${event.stage}): ${event.message}`
      .replace(/[\r\n]/g, ' ')
      .replaceAll(String.fromCharCode(27), ' ')
    process.stderr.write(text + '\n')
    logForDebugging(text)
    diagnostics.push({
      type: 'generic-error',
      source: `plugin:mods:${event.plugin}`,
      plugin: event.plugin,
      error: `${event.stage}: ${event.message}`,
    })
    publishDiagnostics()
    options.onDiagnostic?.(event)
  }

  function enqueue(work: () => Promise<void>): Promise<void> {
    const pending = queue.then(async () => {
      if (!stopped) await work()
    })
    queue = pending.catch(() => {})
    return pending
  }

  function relevantSettings(settings: PrepareModPluginsSettings): string {
    return JSON.stringify([
      ...[
        settings.userSettings,
        settings.flagSettings,
        settings.policySettings,
      ].map(source => ({
        enabledPlugins: source?.enabledPlugins,
        prependPlugins: source?.prependPlugins,
        appendPlugins: source?.appendPlugins,
        pluginConfigs: source?.pluginConfigs,
        disableAllHooks: source?.disableAllHooks,
        allowManagedHooksOnly: source?.allowManagedHooksOnly,
      })),
      settings.hasManagedSettings === true || (settings.policySettings !== null && Object.keys(settings.policySettings).length > 0),
      settings.policySettings?.hooks,
      settings.policySettings?.strictPluginOnlyCustomization,
      settings.hookPolicy,
      settings.subscriptionType,
      settings.enabledOptionSources,
      options.getDisabledReason?.(),
    ])
  }

  function scheduleRefresh() {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void refresh().catch(() => {}) // refresh reports the stage, not raw input
    }, 150)
    timer.unref?.()
  }

  async function watchPlugins(plugins: readonly LoadedPlugin[]) {
    const nextRoots = [
      ...new Set(
        plugins
          .filter(plugin =>
            plugin.hookModules?.some(group => group.paths.length),
          )
          .map(plugin => plugin.path),
      ),
    ].sort()
    if (
      nextRoots.length === roots.length &&
      nextRoots.every((root, index) => root === roots[index])
    )
      return
    const old = watcher
    watcher = undefined
    watcherClosing = old?.close() ?? Promise.resolve()
    await watcherClosing
    if (stopped) return
    roots = nextRoots
    if (roots.length === 0) return
    watcher = chokidar.watch(roots, {
      persistent: false,
      ignoreInitial: true,
      followSymlinks: false,
      usePolling: true,
      interval: 500,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
      ignored: (path, stats) =>
        path.split(sep).includes('.git') ||
        Boolean(stats && !stats.isFile() && !stats.isDirectory()),
    })
    watcher.on('all', () => {
      // Invalidate the declaration cache only on an actual owned-file change,
      // never on polling ticks. This picks up imports and hooks.json changes.
      if (stopped) return
      clearPluginCache()
      scheduleRefresh()
    })
    watcher.on('error', () =>
      diagnostic({
        plugin: 'host',
        stage: 'watch',
        message:
          'Unable to watch module files; use /reload-plugins after changes',
      }),
    )
  }

  async function reconcile(plugins?: readonly LoadedPlugin[]) {
    const settings = readSettings()
    settingsKey = relevantSettings(settings)
    const policy = settings.policySettings
    // Pre now uses the protected tool boundary. Post remains gated until
    // the classic executor supports general updatedToolOutput (not only MCP).
    const managedPostHooks = !settings.hookPolicy.allDisabled && policy?.disableAllHooks !== true
      && (policy?.hooks?.PostToolUse ?? []).some(group => group.hooks.length > 0)
    const disabled = options.getDisabledReason?.()
      ?? (managedPostHooks ? 'Mods with managed tool hooks using PostToolUse remain unsupported (updatedToolOutput); external Mods are not activated' : undefined)
      ?? (policy?.allowManagedHooksOnly || policy?.strictPluginOnlyCustomization
        ? 'Managed Mods protection is not supported by this slice; external Mods are not activated' : undefined)
    const loaded = plugins ?? (await loadPlugins())
    if (stopped || isShuttingDown()) return
    const prepared = prepareModPlugins(loaded, settings)
    const origins = new Map(loaded.filter(plugin => plugin.enabled !== false)
      .map(plugin => [getPluginStorageId(plugin), getModPluginOrigin(plugin, settings)]))
    services.pluginOrigin = storageId => origins.get(storageId)
    diagnostics = []
    reported.clear()
    for (const error of prepared.errors) diagnostic(error)
    if (
      disabled &&
      loaded.some(plugin =>
        plugin.hookModules?.some(group => group.paths.length),
      )
    ) {
      diagnostic({ plugin: 'host', stage: 'unsupported', message: disabled })
    }
    const inputs = disabled ? [] : seatNativeModPlugins(prepared.inputs, settings)
    if (!runtime && inputs.length > 0) {
      runtime = (options.createRuntime ?? createModsRuntime)({
        onDiagnostic: diagnostic,
        services,
      })
      unsubscribeUi = runtime.ui.subscribe(() => {
        for (const listener of uiListeners) listener()
      })
      unsubscribeCommands = runtime.commands.subscribe(() => {
        for (const listener of commandListeners) listener()
      })
      unregisterShutdown = registerModsHostDisposer(
        dispose,
        (reason, timeoutMs, sessionId) =>
          runtime!.endSession(reason, timeoutMs, sessionId),
      )
    }
    if (runtime) {
      // A clear can bind the runtime directly through ToolUseContext. Do not
      // replay the host's older binding when only declarations are refreshed.
      await runtime.reconcile(inputs)
      if (stopped) return
      if (binding && !runtimeBound) {
        await runtime.bind(binding)
        runtimeBound = true
      }
    }
    if (stopped) return
    await watchPlugins(disabled ? [] : loaded)
    if (!stopped && (diagnostics.length > 0 || setAppState))
      publishDiagnostics()
  }

  function refresh(plugins?: readonly LoadedPlugin[]): Promise<void> {
    if (stopped || isShuttingDown() || !options.isTrusted) return Promise.resolve()
    initialize()
    if (timer) clearTimeout(timer)
    timer = undefined
    return enqueue(async () => {
      try {
        await reconcile(plugins)
      } catch (error) {
        if (!stopped)
          diagnostic({
            plugin: 'host',
            stage: 'refresh',
            message:
              'Unable to refresh Mods; the current runtime is retained. Use /reload-plugins to retry.',
          })
        throw error
      }
    })
  }

  function initialize() {
    if (initialized || stopped || !options.isTrusted) return
    initialized = true
    unregisterCleanup = registerCleanup(dispose)
    unsubscribePlugins = subscribePluginRefresh(plugins => {
      if (plugins) return refresh(plugins)
      scheduleRefresh()
    })
    unsubscribeSettings = settingsChangeDetector.subscribe(() => {
      if (stopped) return
      const nextKey = relevantSettings(readSettings())
      if (nextKey !== settingsKey) {
        settingsKey = nextKey
        clearPluginCache()
        scheduleRefresh()
      }
    })
  }

  function dispose(): Promise<void> {
    if (disposal) return disposal
    stopped = true
    receiveController.abort(new Error('Mods session disposed'))
    firstBinding.resolve()
    if (timer) clearTimeout(timer)
    timer = undefined
    unsubscribeSettings?.()
    unsubscribePlugins?.()
    const close = Promise.all([watcherClosing, watcher?.close()])
    watcher = undefined
    // Close watchers before the first awaited runtime teardown. Async loads and
    // watcher replacement both recheck stopped, so neither can resurrect work.
    disposal = (async () => {
      try {
        await close
      } finally {
        try {
          await runtime?.dispose()
        } finally {
          await queue
          unsubscribeUi?.()
          uiListeners.clear()
          unsubscribeCommands?.()
          commandListeners.clear()
          unregisterShutdown?.()
          unregisterCleanup?.()
        }
      }
    })()
    return disposal
  }

  return {
    commands,
    ui,
    get runtime() {
      return stopped ? undefined : runtime
    },
    /** Await before processing a prompt, including slash commands that fork. */
    async bind(next: ModBinding, updateState?: SetAppState, hostServices?: ModHostServices): Promise<void> {
      if (stopped || !options.isTrusted) return
      if (hostServices) Object.assign(services, hostServices)
      if (updateState) setAppState = updateState
      const changed =
        !binding ||
        Object.keys(next).some(
          key =>
            next[key as keyof ModBinding] !== binding![key as keyof ModBinding],
        )
      if (binding && binding.sessionId !== next.sessionId) {
        receiveController.abort(new Error('Mods session changed'))
        receiveController = new AbortController()
      }
      binding = next
      if (changed) runtimeBound = false
      const first = !initialized
      initialize()
      if (first || timer) await refresh()
      else if (runtime)
        await enqueue(async () => {
          await runtime!.bind(next)
          runtimeBound = true
        })
      else await queue
      firstBinding.resolve()
    },
    async receive(input: SessionReceiveInput, admit: (input: SessionReceiveInput) => void | SessionReceiveResult | Promise<void | SessionReceiveResult>, signal?: AbortSignal) {
      const lifetime = receiveController.signal
      const combined = createCombinedAbortSignal(signal, { signalB: lifetime })
      let abort: (() => void) | undefined
      let snapshot: ReturnType<ModsRuntime['capture']> | undefined
      try {
        combined.signal.throwIfAborted()
        if (options.isTrusted) {
          const aborted = new Promise<never>((_, reject) => {
            abort = () => reject(combined.signal.reason)
            combined.signal.addEventListener('abort', abort, { once: true })
          })
          await Promise.race([firstBinding.promise, aborted])
          await Promise.race([queue, aborted])
        }
        combined.signal.throwIfAborted()
        snapshot = runtime?.capture()
        return await runModSessionReceive(snapshot, input, admit, combined.signal)
      } catch (error) {
        signal?.throwIfAborted()
        lifetime.throwIfAborted()
        throw error
      } finally {
        if (abort) combined.signal.removeEventListener('abort', abort)
        snapshot?.release()
        combined.cleanup()
      }
    },
    refresh,
    dispose,
  }
}

export type ModsSession = ReturnType<typeof createModsSession>
