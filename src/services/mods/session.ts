import chokidar, { type FSWatcher } from 'chokidar'
import { basename, dirname, extname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import type { AppState } from '../../state/AppState.js'
import type { PromptRequest, PromptResponse } from '../../types/hooks.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { recordDevModsConsent } from '../../utils/sessionStorage.js'
import type { Tool, Tools } from '../../Tool.js'
import type { Command } from '../../types/command.js'
import type { LoadedPlugin, PluginError } from '../../types/plugin.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { subscribeRateLimitUsage } from '../claudeAiLimits.js'
import { getSubscriptionType } from '../../utils/auth.js'
import { seatNativeModPlugins } from './native.js'
import { appendModQueueRecord } from './sessionAppend.js'
import { modSessionIdentity } from './sessionIdentity.js'
import { setQueueRecordRewriter } from '../../utils/messageQueueManager.js'
import { esmModuleExtensions } from './loader.js'
import { logForDebugging } from '../../utils/debug.js'
import { getIsNonInteractiveSession, getPrintOutputFormat } from '../../bootstrap/state.js'
import { errorMessage, isENOENT } from '../../utils/errors.js'
import { pathExists } from '../../utils/file.js'
import { stripBOM } from '../../utils/jsonRead.js'
import { jsonParse } from '../../utils/slowOperations.js'
import { PluginHooksSchema } from '../../utils/plugins/schemas.js'
import { isShuttingDown, registerModsHostDisposer } from '../../utils/gracefulShutdown.js'
import {
  shouldAllowManagedHooksOnly,
  shouldDisableAllHooksIncludingManaged,
} from '../../utils/hooks/hooksConfigSnapshot.js'
import { subscribePluginRefresh } from '../../utils/plugins/cacheUtils.js'
import {
  clearPluginCache,
  loadAllPluginsCacheOnly,
  loadSessionOnlyPlugins,
  mergePluginSources,
} from '../../utils/plugins/pluginLoader.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import { getEnabledSettingSources } from '../../utils/settings/constants.js'
import { getMdmSettings } from '../../utils/settings/mdm/settings.js'
import {
  getSettingsForSource,
  getVouchedPolicySettings,
  loadManagedFileSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import {
  validateUserConfig,
  type UserConfigValues,
} from '../../utils/plugins/mcpbHandler.js'
import { getModPluginOrigin, prepareModPlugins, type PrepareModPluginsSettings } from './plugins.js'
import {
  getPluginStorageId,
  resolvePluginOptions,
  subscribePluginOptionsChange,
} from '../../utils/plugins/pluginOptionsStorage.js'
import type { ModConfigRowProvider } from './config.js'
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

export class ModAuthoringPromptDismissedError extends Error {
  constructor() {
    super('Mod authoring prompt dismissed')
    this.name = 'ModAuthoringPromptDismissedError'
  }
}

export type ModsSessionOptions = {
  /** Skip plugin discovery/execution while retaining the local SDK UI engine. */
  bare?: boolean
  /** The CLI supplies this only after its trust gate (print mode has implicit trust). */
  isTrusted: boolean
  getDisabledReason?: () => string | undefined
  loadPlugins?: () => Promise<readonly LoadedPlugin[]>
  loadAuthoringPlugin?: (
    path: string,
  ) => Promise<
    | LoadedPlugin
    | { plugin: LoadedPlugin; errors: PluginError[] }
    | undefined
  >
  authoringRoot?: (sessionId: string) => string
  persistAuthoringConsent?: (root: string) => Promise<void>
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
  let watchTargets: string[] = []
  // Plugin roots kept under watch until the next explicit reload, each with the
  // last version that named hooks modules (undefined once a valid config unloaded them).
  const watchedPlugins = new Map<string, LoadedPlugin | undefined>()
  // The file whose change asks each watched root to reload; a manifest outranks a module source.
  const causes = new Map<string, { path: string; manifest: boolean; changed: boolean }>()
  const reloadFailures = new Set<string>()
  // Every hooks config a watched plugin has named, so one that stops naming modules is still a manifest.
  const hookConfigs = new Set<string>()
  let unsubscribeUsage: (() => void) | undefined
  let unsubscribeSettings: (() => void) | undefined
  let unsubscribePlugins: (() => void) | undefined
  let unsubscribeOptions: (() => void) | undefined
  let unregisterShutdown: (() => void) | undefined
  let unregisterCleanup: (() => void) | undefined
  let settingsKey: string | undefined
  let diagnostics: PluginError[] = []
  const reported = new Set<string>()
  let workerDeath: string | undefined
  /** Load failures for $.ui.log that arrived before a host bound it. */
  let pendingLoadLogs: { plugin: string; text: string }[] = []
  // Retired activations may still report errors after a token is rotated.
  const diagnosticSecrets = new Set<string>()
  let configPlugins: readonly LoadedPlugin[] = []
  let authoringRoot: string | undefined
  let restoredAuthoringRoot: string | undefined
  let authoringRestorePending = false
  let authoringEnabled = false
  let authoringPending = false
  let authoringGeneration = 0
  let authoringConsent: Promise<{ enabled: boolean; root?: string }> | undefined
  let authoringPrompt: ((request: PromptRequest, signal?: AbortSignal) => Promise<PromptResponse>) | undefined
  let authoringRetryPending = false
  let authoringRetry: Promise<void> | undefined
  let authoringController = new AbortController()
  const authoringPlugins = new Map<string, LoadedPlugin>()
  let builtinConfigRows: ModHostServices['configRows']
  const services: ModHostServices = {
    configRows: async () => [
      ...(await (builtinConfigRows?.() ?? [])),
      ...pluginConfigRows(),
    ],
  }
  const renderListeners = new Set<() => void>()
  let renderSnapshot: { runtime: ModsRuntime; version: number } | undefined
  let unsubscribeRender: (() => void) | undefined
  const publishRender = () => {
    renderSnapshot = !stopped && runtime ? { runtime, version: runtime.renderHooks.getSnapshot() } : undefined
    for (const listener of renderListeners) listener()
  }
  const renderHooks = {
    getSnapshot: () => renderSnapshot,
    subscribe(listener: () => void) {
      renderListeners.add(listener)
      return () => { renderListeners.delete(listener) }
    },
  }
  const uiListeners = new Set<() => void>()
  const emptyPanes: readonly ModUiPane[] = Object.freeze([])
  let unsubscribePlaced: (() => void) | undefined
  let unsubscribeUi: (() => void) | undefined
  const ui = {
    getSnapshot: () => runtime?.ui.getSnapshot() ?? emptyPanes,
    subscribe(listener: () => void) {
      uiListeners.add(listener)
      return () => { uiListeners.delete(listener) }
    },
    render: (presentation: ModUiPresentation) => runtime?.ui.render(presentation, { nativeSites: false }) ?? Promise.resolve(),
  }
  const commandListeners = new Set<() => void>()
  const emptyCommands: Command[] = []
  let unsubscribeCommands: (() => void) | undefined
  const commands = {
    getSnapshot: () => stopped ? emptyCommands : runtime?.commands.getSnapshot() ?? emptyCommands,
    subscribe(listener: () => void) {
      commandListeners.add(listener)
      return () => { commandListeners.delete(listener) }
    },
    projection: (existing: Command[]) => stopped ? existing : runtime?.commands.projection(existing) ?? existing,
    describe: (existing: Command[]) => stopped ? Promise.resolve(existing) : runtime?.commands.describe(existing) ?? Promise.resolve(existing),
  }

  const toolListeners = new Set<() => void>()
  const emptyTools: Tool[] = []
  let unsubscribeTools: (() => void) | undefined
  let unsubscribeAgents: (() => void) | undefined
  function publishAgents() {
    if (!setAppState || !runtime?.agents) return
    setAppState(previous => {
      const agentDefinitions = runtime!.agents.projection(previous.agentDefinitions)
      return agentDefinitions === previous.agentDefinitions ? previous : {...previous, agentDefinitions}
    })
  }

  const tools = {
    getSnapshot: () => runtime?.tools?.getSnapshot() ?? emptyTools,
    subscribe(listener: () => void) {
      toolListeners.add(listener)
      return () => { toolListeners.delete(listener) }
    },
    projection: (existing: Tools) => runtime?.tools?.projection(existing) ?? existing,
  }

  const readSettings =
    options.getSettings ??
    (() => ({
      userSettings: getSettingsForSource('userSettings'),
      flagSettings: getSettingsForSource('flagSettings'),
      policySettings: getSettingsForSource('policySettings'),
      policyPluginOrdering: getVouchedPolicySettings(),
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

  function pluginConfigRows(): ModConfigRowProvider[] {
    const settings = readSettings()
    return configPlugins
      .filter(plugin => plugin.enabled !== false)
      .flatMap(plugin => {
        const storageId = getPluginStorageId(plugin)
        const usesInlineName =
          storageId.endsWith('@inline') &&
          [
            settings.userSettings,
            settings.flagSettings,
            settings.policySettings,
          ].some(
            source => source?.pluginConfigs?.[plugin.name] !== undefined,
          )
        const configId = usesInlineName ? plugin.name : storageId
        const readOptions = (source: SettingsJson | null) =>
          Object.assign(
            {},
            storageId.endsWith('@inline')
              ? source?.pluginConfigs?.[plugin.name]?.options
              : undefined,
            source?.pluginConfigs?.[storageId]?.options,
          )
        const saved = Object.assign(
          {},
          settings.enabledOptionSources?.user === false
            ? {}
            : readOptions(settings.userSettings),
          settings.enabledOptionSources?.flag === false
            ? {}
            : readOptions(settings.flagSettings),
          readOptions(settings.policySettings),
        )
        const schema = plugin.manifest.userConfig ?? {}
        const values = resolvePluginOptions(schema, saved)

        return Object.entries(schema).map(
          ([key, field]): ModConfigRowProvider => {
            const storedValue = (value: ModConfigRowProvider['value']) =>
              (Array.isArray(value) ? [...value] : value) as UserConfigValues[string]
            return {
            key: `${plugin.name}.${key}`,
            label: field.title || key,
            ...(field.description === undefined
              ? {}
              : { description: field.description }),
            kind:
              field.type === 'boolean'
                ? 'boolean'
                : field.type === 'number'
                  ? 'number'
                  : field.options
                    ? 'choice'
                    : 'text',
            value: field.sensitive
              ? ''
              : field.multiple &&
                  (values[key] === undefined || values[key] === '')
                ? []
                : values[key] ?? '',
            ...(field.options === undefined ? {} : { options: field.options }),
            provider: getModPluginOrigin(plugin, settings),
            isLocked: Object.hasOwn(
              settings.policySettings?.pluginConfigs?.[configId]?.options ?? {},
              key,
            ),
            ...(field.sensitive
              ? {}
              : {
                  validate: value => {
                    const result = validateUserConfig(
                      { [key]: storedValue(value) },
                      { [key]: field },
                    )
                    return result.valid
                      ? undefined
                      : result.errors.join('; ')
                  },
                  set: value => {
                    const result = updateSettingsForSource('userSettings', {
                      pluginConfigs: {
                        [configId]: {
                          options: { [key]: storedValue(value) },
                        },
                      },
                    })
                    if (result.error) throw result.error
                    scheduleRefresh()
                  },
                }),
            }
          },
        )
      })
  }

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
    const redact = (value: string) => {
      for (const secret of [...diagnosticSecrets].sort((a, b) => b.length - a.length)) value = value.replaceAll(secret, '[REDACTED]')
      return value
    }
    event = { ...event, message: redact(event.message) }
    if (event.stage === 'reload') reloadFailures.add(event.plugin)
    // Official 2.1.329 tells of a skipped hook once per plugin, event and way it failed.
    const key = event.hook ? `${event.plugin}:${event.stage}:hook:${event.hook.kind}` : `${event.plugin}:${event.stage}:${event.message}`
    if (reported.has(key) && !event.workerFault) return
    reported.add(key)
    // Do not serialize settings, options, event input or stack traces here.
    const text = `[Mods] ${event.plugin} (${event.stage}): ${event.message}`
      .replace(/[\r\n]/g, ' ')
      .replaceAll(String.fromCharCode(27), ' ')
    if (event.workerFault) workerDeath = event.message
    // One Worker crash rejects every pending call and environment with the same error;
    // the runtime already shows "<plugin> was unloaded" for an attributed crash.
    const cascade = event.message === 'Module environment unloaded' ||
      (event.message === workerDeath && (!event.workerFault || event.workerFault.culprit !== undefined))
    // Raw stderr is overdrawn by the interactive TUI, which shows the diagnostic itself.
    // Official 2.1.329 words a load failure as "<plugin>: hooks module did not load: <error>".
    const line = event.hook ? `${event.stage} hook skipped: ${redact(event.hook.why)}` :
      event.stage === 'reload' ? event.message.replace(/^The previous/, 'reload failed, the previous') :
      event.stage !== 'load' ? `${event.stage}: ${event.message}` :
      event.message.startsWith('hooks module did not load') ? event.message : `hooks module did not load: ${event.message}`
    // Official 2.1.329 sends a load failure to $.ui.log only for a watched plugin directory (interactive
    // by default), else to an error-level log line; stderr carries it only for an inline plugin in text output.
    const loadFailure = event.stage === 'load'
    const headless = binding ? !binding.isInteractive : getIsNonInteractiveSession()
    // Official 2.1.329 logs every module that fails to load at error level, under its storage id.
    if (event.storageId && (loadFailure || event.stage === 'reload'))
      logForDebugging(`hooks module ${redact(event.storageId)} failed to load: ${event.plugin}: ${loadFailure ? event.message.replace(/^hooks module did not load: /, '') : event.message.replace(/^The previous version stays loaded: /, '')}`, { level: 'error' })
    if (loadFailure) {
      const inline = event.storageId?.endsWith('@inline') === true
      const watch = process.env.CLAUDE_CODE_PLUGIN_DIR_WATCH
      const watched = inline && (watch === undefined ? !headless : watch !== '0' && watch !== 'false')
      if (!watched) logForDebugging(`${event.plugin}: ${line}`, { level: 'error' })
      else if (!headless) logForDebugging(`[${event.plugin}] $.ui.log: ${line}`)
      if (!headless) { if (services.uiDiagnostic && !cascade) services.uiDiagnostic(event.plugin, line.replace(/[\r\n]/g, ' ')) }
      else if (watched) {
        if (services.uiLog) services.uiLog(event.plugin, line, 'transcript')
        else pendingLoadLogs.push({ plugin: event.plugin, text: line })
      }
      if (headless && inline && getPrintOutputFormat() === 'text' && process.env.CLAUDE_CODE_SESSION_KIND !== 'bg')
        process.stderr.write(`${event.plugin}: ${line.replace(/\n/g, '\n  ')}\n`)
    } else if (event.hook) {
      // Official 2.1.329 (its $X and e_t) logs a skipped hook at error level, or to $.ui.log while its plugin
      // directory is watched; stderr carries it only for an inline plugin in headless text output.
      const inline = event.storageId?.endsWith('@inline') === true
      const watch = process.env.CLAUDE_CODE_PLUGIN_DIR_WATCH
      const watched = inline && (watch === undefined ? !headless : watch !== '0' && watch !== 'false')
      const shown = line.replace(/[\r\n]/g, ' ')
      if (!watched) logForDebugging(`${event.plugin}: ${shown}`, { level: 'error' })
      else logForDebugging(`[${event.plugin}] $.ui.log: ${shown}`)
      if (!headless) { if (services.uiDiagnostic && !cascade) services.uiDiagnostic(event.plugin, shown) }
      else if (watched) services.uiLog?.(event.plugin, shown, 'transcript')
      if (headless && inline && getPrintOutputFormat() === 'text' && process.env.CLAUDE_CODE_SESSION_KIND !== 'bg')
        process.stderr.write(`${event.plugin}: ${shown}\n`)
    } else if (services.uiDiagnostic) { if (!cascade) services.uiDiagnostic(event.plugin, line.replace(/[\r\n]/g, ' ')) }
    else process.stderr.write(text + '\n')
    const fault = event.workerFault
    if (!loadFailure && !event.hook) logForDebugging(text + (fault ? ` workerFault=${JSON.stringify({
      cause: fault.cause, workerAgeMs: fault.workerAgeMs, pendingRequests: fault.pendingRequests,
      ...(fault.pingAgeMs === undefined ? {} : {pingAgeMs:fault.pingAgeMs}),
      ...(fault.culprit && {culprit: {
        environment:fault.culprit.environment, plugin:redact(fault.culprit.plugin), storageId:redact(fault.culprit.storageId),
        evidence:fault.culprit.evidence, stage:fault.culprit.stage,
        ...(fault.culprit.requestId === undefined ? {} : {requestId:fault.culprit.requestId}),
        ...(fault.culprit.settledRequestId === undefined ? {} : {settledRequestId:fault.culprit.settledRequestId}),
        ...(fault.culprit.handle === undefined ? {} : {handle:fault.culprit.handle}),
      }}),
    })}` : ''))
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
    return createHash('sha256').update(JSON.stringify([
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
      settings.hookPolicy,
      settings.subscriptionType,
      settings.enabledOptionSources,
      settings.policyPluginOrdering,
      options.getDisabledReason?.(),
    ])).digest('hex')
  }

  function authoringOwns(path: string): boolean {
    if (!authoringEnabled || !authoringRoot) return false
    const child = relative(authoringRoot, path)
    return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
  }

  function deferAuthoringRefresh(): boolean {
    if (!runtime?.activePublicTurnId) return false
    authoringPending = true
    return true
  }

  function scheduleRefresh(authoringChange = false) {
    if (stopped || (authoringChange && deferAuthoringRefresh())) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void refresh(undefined, authoringChange).catch(() => {}) // refresh reports the stage, not raw input
    }, 150)
    timer.unref?.()
  }

  /** undefined: the hooks config still parses; '': it is gone; otherwise why it is invalid. */
  async function hooksConfigFailure(configPath: string): Promise<string | undefined> {
    try {
      PluginHooksSchema().parse(jsonParse(stripBOM(await readFile(configPath, 'utf8'))))
      return undefined
    } catch (error) {
      return isENOENT(error) ? '' : errorMessage(error)
    }
  }

  /**
   * Between explicit reloads a watched plugin keeps the modules of a hooks config
   * that is missing or invalid, and all of them while its --plugin-dir directory
   * is gone; only a valid config that names no module unloads them. `failed` maps
   * the roots whose config is invalid, which stay on the version already loaded.
   */
  async function holdWatchedPlugins(found: readonly LoadedPlugin[]) {
    const configured = [...found]
    const failed = new Map<string, string>()
    const gone = new Set<string>()
    for (const plugin of found) for (const group of plugin.hookModules ?? []) hookConfigs.add(group.configPath)
    for (const [root, previous] of watchedPlugins) {
      if (!previous) continue
      const index = configured.findIndex(plugin => plugin.path === root)
      const current = configured[index]
      if (!current) {
        if (previous.source.endsWith('@inline') && !(await pathExists(root))) { configured.push(previous); gone.add(root) }
        else watchedPlugins.delete(root)
        continue
      }
      // Held groups keep their place, so hooks stay registered in the same order.
      const found = current.hookModules ?? []
      const groups: typeof found = []
      for (const group of previous.hookModules ?? []) {
        const now = found.find(other => other.configPath === group.configPath)
        if (now?.paths.length || !group.paths.length) continue
        const failure = await hooksConfigFailure(group.configPath)
        if (failure === undefined) continue
        groups.push(group)
        if (failure) failed.set(root, failure)
      }
      if (groups.length) {
        const order = (previous.hookModules ?? []).map(group => group.configPath)
        const seat = (group: (typeof found)[number]) => (order.indexOf(group.configPath) + 1) || order.length + 1
        configured[index] = { ...current, hookModules: [...groups, ...found.filter(group => !groups.some(held => held.configPath === group.configPath))].sort((a, b) => seat(a) - seat(b)) }
      }
      const merged = configured[index]!.hookModules ?? []
      if (!merged.some(group => group.paths.length)) watchedPlugins.set(root, undefined)
      // A loaded module file that is missing is treated like a missing root: nothing is read until it is back.
      const entries = (groups: typeof found) => groups.flatMap(group => group.paths.map(path => join(dirname(group.configPath), path)))
      const loadedEntries = entries(previous.hookModules ?? [])
      for (const entry of entries(merged)) if (loadedEntries.includes(entry) && !(await pathExists(entry))) gone.add(root)
    }
    for (const plugin of configured) {
      if (plugin.isBuiltin !== true && !authoringOwns(plugin.path) && plugin.hookModules?.some(group => group.paths.length))
        watchedPlugins.set(plugin.path, plugin)
    }
    return { configured, failed, gone }
  }

  const isManifest = (root: string, path: string) =>
    path === join(root, '.claude-plugin', 'plugin.json') || path === join(root, 'hooks', 'hooks.json') || hookConfigs.has(path)

  /** What a watched plugin is told after the change to `cause` was applied, in official 2.1.329's words. */
  function reloadNotice(root: string, cause: { path: string; manifest: boolean }, previous: LoadedPlugin | undefined, current: LoadedPlugin | undefined, events: string[] | undefined) {
    const modules = (plugin: LoadedPlugin | undefined) =>
      (plugin?.hookModules ?? []).flatMap(group => group.paths.map(path => relative(root, join(dirname(group.configPath), path)))).join(', ') || 'none'
    const hooks = () => `${events!.length} ${events!.length === 1 ? 'hook' : 'hooks'}${events!.length ? `: ${events!.join(', ')}` : ''}`
    if (!cause.manifest) return events && `reloaded (${hooks()})`
    const before = modules(previous), now = modules(current)
    if (now === 'none') return `${basename(cause.path)} changed \u2014 names no hooks module now; ${before === 'none' ? 'nothing to unload' : `${before} unloaded`}`
    return events && `${basename(cause.path)} changed \u2014 reloaded (modules: ${before === now ? `${now} unchanged` : `${before} \u2192 ${now}`}; ${hooks()})`
  }

  async function watchPlugins() {
    const watchEnabled = binding?.isInteractive || process.env.CLAUDE_CODE_PLUGIN_DIR_WATCH === '1'
    const nextRoots = watchEnabled ? [
      ...new Set([
        ...(authoringEnabled && authoringRoot ? [authoringRoot] : []),
        ...watchedPlugins.keys(),
      ]),
    ].sort() : []
    // A root that is gone is watched through its nearest existing ancestor, so recreating it is noticed.
    const nextTargets = await Promise.all(nextRoots.map(async root => {
      let target = root
      while (dirname(target) !== target && !(await pathExists(target))) target = dirname(target)
      return target
    }))
    if (
      nextRoots.length === roots.length &&
      nextRoots.every((root, index) => root === roots[index] && nextTargets[index] === watchTargets[index])
    )
      return
    const old = watcher
    watcher = undefined
    watcherClosing = old?.close() ?? Promise.resolve()
    await watcherClosing
    if (stopped) return
    roots = nextRoots
    watchTargets = nextTargets
    if (roots.length === 0) return
    watcher = chokidar.watch([...new Set(watchTargets)], {
      persistent: false,
      ignoreInitial: true,
      followSymlinks: false,
      usePolling: true,
      interval: 500,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
      // Only module sources and JSON (hooks.json, plugin.json) can change a declaration.
      ignored: (path, stats) => {
        path = normalize(path) // chokidar hands over forward slashes on Windows
        const root = roots.find(root => path === root || path.startsWith(root + sep))
        if (root === undefined) return !roots.some(root => root.startsWith(path + sep))
        return relative(root, path).split(sep).some(part => part === '.git' || part === 'node_modules') ||
          Boolean(stats && !stats.isFile() && !stats.isDirectory()) ||
          Boolean(stats?.isFile() && extname(path) !== '.json' && !esmModuleExtensions.includes(extname(path)))
      },
    })
    watcher.on('all', (event, path: string) => {
      // Invalidate the declaration cache only on an actual owned-file change,
      // never on polling ticks. This picks up imports and hooks.json changes.
      if (stopped) return
      clearPluginCache()
      path = normalize(path)
      const root = [...watchedPlugins.keys()].find(root => path === root || path.startsWith(root + sep))
      // A file that went away is no reason to load again; the loaded version stays until it is back.
      if (root !== undefined && event !== 'unlink' && event !== 'unlinkDir') {
        // A root that came back is read again as a whole; its hooks config answers for that.
        const cause = path === root ? watchedPlugins.get(root)?.hookModules?.[0]?.configPath ?? join(root, '.claude-plugin', 'plugin.json') : path
        const manifest = isManifest(root, cause)
        if (manifest || !causes.get(root)?.manifest) causes.set(root, { path: cause, manifest, changed: event === 'change' })
      }
      scheduleRefresh(authoringOwns(path))
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

  async function loadAuthoringChildren(
    enabledPlugins: SettingsJson['enabledPlugins'],
  ): Promise<PluginError[]> {
    if (!authoringEnabled || !authoringRoot) return []
    let children: string[]
    try {
      children = (await readdir(authoringRoot, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
        .map(entry => join(authoringRoot!, entry.name))
        .sort()
    } catch (error) {
      return [{
        type: 'generic-error',
        source: 'plugin:mods:host',
        plugin: 'host',
        error: `authoring: Unable to read this session's Mods folder: ${error instanceof Error ? error.message : String(error)}`,
      }]
    }
    const next = new Map<string, LoadedPlugin>()
    const errors: PluginError[] = []
    if (!options.loadAuthoringPlugin) {
      const loaded = await loadSessionOnlyPlugins(children, enabledPlugins)
      for (const plugin of loaded.plugins) next.set(plugin.path, plugin)
      errors.push(...loaded.errors)
    } else {
      for (const child of children) {
        try {
          const result = await options.loadAuthoringPlugin(child)
          if (!result) continue
          const loaded = 'plugin' in result ? result.plugin : result
          if ('plugin' in result) errors.push(...result.errors)
          loaded.source = `${loaded.name}@inline`
          loaded.repository = loaded.source
          loaded.enabled = enabledPlugins?.[loaded.source] !== false
          next.set(child, loaded)
        } catch (error) {
          errors.push({
            type: 'generic-error',
            source: `${basename(child)}@inline`,
            plugin: basename(child),
            error: `authoring: ${error instanceof Error ? error.message : String(error)}`,
          })
        }
      }
    }
    authoringPlugins.clear()
    for (const [path, plugin] of next) authoringPlugins.set(path, plugin)
    return errors
  }

  function effectiveEnabledPlugins(
    settings: PrepareModPluginsSettings,
  ): SettingsJson['enabledPlugins'] {
    return Object.assign(
      {},
      settings.userSettings?.enabledPlugins,
      settings.flagSettings?.enabledPlugins,
      settings.policySettings?.enabledPlugins,
    )
  }

  function managedPluginNames(settings: PrepareModPluginsSettings): Set<string> | null {
    const names = new Set<string>()
    for (const [pluginId, value] of Object.entries(
      settings.policySettings?.enabledPlugins ?? {},
    )) {
      if (typeof value !== 'boolean' || !pluginId.includes('@')) continue
      const name = pluginId.split('@')[0]
      if (name) names.add(name)
    }
    return names.size > 0 ? names : null
  }

  async function reconcile(plugins?: readonly LoadedPlugin[], deferAuthoring = false) {
    const settings = readSettings()
    settingsKey = relevantSettings(settings)
    const disabled = options.getDisabledReason?.()
    if (plugins) watchedPlugins.clear()
    // Only a change the watcher saw is told; an explicit reload reports for itself.
    const pending = plugins ? [] : [...causes].map(([root, cause]) => ({ root, cause, previous: watchedPlugins.get(root) }))
    causes.clear()
    reloadFailures.clear()
    const { configured, failed, gone } = await holdWatchedPlugins(options.bare ? [] : plugins ?? (await loadPlugins()))
    const authoringErrors = deferAuthoring || options.bare
      ? []
      : await loadAuthoringChildren(effectiveEnabledPlugins(settings))
    if (stopped || isShuttingDown()) return
    const { plugins: loaded, errors: mergeErrors } = mergePluginSources({
      session: options.bare ? [] : [...authoringPlugins.values()],
      marketplace: configured.filter(plugin => plugin.isBuiltin !== true),
      builtin: configured.filter(plugin => plugin.isBuiltin === true),
      managedNames: managedPluginNames(settings),
    })
    configPlugins = loaded
    const prepared = prepareModPlugins(loaded, settings)
    for (const input of prepared.inputs) {
      const failure = failed.get(input.pluginRoot)
      if (gone.has(input.pluginRoot)) input.keepLoaded = true
      // The reason is shown the way official 2.1.329 writes plugin errors.
      if (failure) input.loadError = `Hook load failed: ${failure.replace(/\s+/g, ' ').trim().replace(/"/g, '\u201D').replace(/'/g, '\u2019')}`
      const schema = loaded.find(plugin => getPluginStorageId(plugin) === input.storageId)?.manifest.userConfig
      for (const [key, field] of Object.entries(schema ?? {})) {
        if (!field.sensitive) continue
        const value = input.options?.[key]
        for (const secret of Array.isArray(value) ? value : [value]) {
          if (secret !== undefined && String(secret) !== '') diagnosticSecrets.add(String(secret))
        }
      }
    }
    const origins = new Map(loaded.filter(plugin => plugin.enabled !== false)
      .map(plugin => [getPluginStorageId(plugin), getModPluginOrigin(plugin, settings)]))
    services.pluginOrigin = storageId => origins.get(storageId)
    const managed = new Set(loaded.filter(plugin => plugin.enabled !== false && plugin.managedSource === true &&
      settings.policySettings?.enabledPlugins?.[getPluginStorageId(plugin)] === true).map(getPluginStorageId))
    services.sessionIdentity = storageId => managed.has(storageId) ? modSessionIdentity() : undefined
    diagnostics = [...authoringErrors, ...mergeErrors]
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
    const inputs = disabled || options.bare ? [] : seatNativeModPlugins(prepared.inputs, settings)
    const hasConfigRows = loaded.some(
      plugin =>
        plugin.enabled !== false &&
        !plugin.hookModules?.some(group => group.paths.length) &&
        Object.keys(plugin.manifest.userConfig ?? {}).length > 0,
    )
    if (!runtime && !disabled && (options.bare || inputs.length > 0 || hasConfigRows)) {
      const created = (options.createRuntime ?? createModsRuntime)({
        onDiagnostic: diagnostic,
        services,
      })
      if (binding) await created.bind(binding)
      if (stopped) {
        await created.dispose()
        return
      }
      runtime = created
      setQueueRecordRewriter((text, origin) => {
        const snapshot = runtime?.capture()
        if (!snapshot?.hasHooks('session.append')) {
          snapshot?.release()
          return undefined
        }
        const promptOrigin = origin === undefined ? { kind: 'unclassified' } : origin.kind === 'human' ? { kind: 'composer' } : structuredClone(origin)
        return appendModQueueRecord(snapshot, text, promptOrigin).finally(() => snapshot.release())
      })
      unsubscribeRender = runtime.renderHooks.subscribe(publishRender)
      publishRender()
      runtimeBound = binding !== undefined
      unsubscribePlaced = runtime.placed?.subscribe(() => {for (const listener of uiListeners) listener()})
      unsubscribeUi = runtime.ui.subscribe(() => {
        for (const listener of uiListeners) listener()
      })
      unsubscribeCommands = runtime.commands.subscribe(() => {
        for (const listener of commandListeners) listener()
      })
      unsubscribeAgents = runtime.agents?.subscribe(publishAgents)
      unsubscribeTools = runtime.tools?.subscribe(() => {
        for (const listener of toolListeners) listener()
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
      const asked = pending.flatMap(change => {
        const input = gone.has(change.root) ? undefined : inputs.find(input => input.pluginRoot === change.root)
        return input ? [{ ...change, input, loaded: runtime!.loaded(input.storageId) }] : []
      })
      // A manifest, or a loaded module file written again, loads again; any other file only if it changes the declaration.
      await runtime.reconcile(inputs, new Set(asked.filter(({ cause, loaded }) =>
        cause.manifest || (cause.changed && loaded?.modules.includes(cause.path))).map(change => change.input.storageId)))
      if (stopped) return
      for (const { root, cause, previous } of pending) {
        if (gone.has(root)) continue
        const change = asked.find(change => change.root === root)
        const current = configured.find(plugin => plugin.path === root)
        const name = change?.input.name ?? current?.name ?? previous?.name
        if (name === undefined || reloadFailures.has(name)) continue
        const now = change && runtime.loaded(change.input.storageId)
        const text = reloadNotice(root, cause, previous, current, now && now.activation !== change.loaded?.activation ? now.events : undefined)
        if (text) services.uiLog?.(name, text, 'transcript')
      }
      if (binding && !runtimeBound) {
        await runtime.bind(binding)
        runtimeBound = true
      }
    }
    if (stopped) return
    if (disabled) watchedPlugins.clear()
    await watchPlugins()
    if (!stopped && (diagnostics.length > 0 || setAppState))
      publishDiagnostics()
  }

  function authoringRequestIsCurrent(
    sessionId: string,
    generation: number,
    signal: AbortSignal,
  ): boolean {
    return !stopped && !signal.aborted && generation === authoringGeneration && binding?.sessionId === sessionId
  }

  async function enableAuthoring(
    root: string,
    sessionId: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted()
    await mkdir(root, { recursive: true, mode: 0o700 })
    signal.throwIfAborted()
    if (!authoringRequestIsCurrent(sessionId, generation, signal)) return false
    await (options.persistAuthoringConsent ?? recordDevModsConsent)(root)
    signal.throwIfAborted()
    if (!authoringRequestIsCurrent(sessionId, generation, signal)) return false
    authoringRoot = root
    authoringEnabled = true
    if (deferAuthoringRefresh()) return true
    await refresh()
    if (!authoringRequestIsCurrent(sessionId, generation, signal)) {
      authoringRoot = undefined
      authoringEnabled = false
      authoringPlugins.clear()
      return false
    }
    return true
  }

  function refresh(plugins?: readonly LoadedPlugin[], authoringChange = false): Promise<void> {
    if (stopped || isShuttingDown() || !options.isTrusted) return Promise.resolve()
    if (authoringChange && deferAuthoringRefresh()) return Promise.resolve()
    initialize()
    if (timer) clearTimeout(timer)
    timer = undefined
    const deferAuthoring = deferAuthoringRefresh()
    return enqueue(async () => {
      try {
        await reconcile(plugins, deferAuthoring)
      } catch (error) {
        if (!stopped)
          diagnostic({
            plugin: 'host',
            stage: 'refresh',
            message:
              'Unable to refresh Mods. Use /reload-plugins to retry.',
          })
        throw error
      }
    })
  }

  function initialize() {
    if (initialized || stopped || !options.isTrusted) return
    initialized = true
    unregisterCleanup = registerCleanup(dispose)
    unsubscribeUsage = subscribeRateLimitUsage(() => { if (!stopped) void runtime?.measure() })
    unsubscribePlugins = subscribePluginRefresh(plugins => {
      // The caller rebuilt AppState agents without Mod agents; project them
      // again even when this refresh changed none.
      if (plugins) return refresh(plugins).then(publishAgents)
      scheduleRefresh()
    })
    unsubscribeOptions = subscribePluginOptionsChange(scheduleRefresh)
    unsubscribeSettings = settingsChangeDetector.subscribe(() => {
      if (stopped) return
      runtime?.config.refresh()
      const nextKey = relevantSettings(readSettings())
      if (nextKey !== settingsKey) {
        settingsKey = nextKey
        clearPluginCache()
        scheduleRefresh()
      }
    })
  }

  async function requestAuthoringConsent(
    requestPrompt: (
      request: PromptRequest,
      signal?: AbortSignal,
    ) => Promise<PromptResponse>,
    signal: AbortSignal,
  ): Promise<{ enabled: boolean; root?: string }> {
    if (stopped || options.bare || !options.isTrusted || options.getDisabledReason?.() || !binding?.isInteractive)
      return { enabled: false }
    authoringPrompt = requestPrompt
    if (authoringEnabled && authoringRoot)
      return { enabled: true, root: authoringRoot }
    if (authoringConsent) return authoringConsent
    const generation = authoringGeneration
    const consent = (async () => {
      const sessionId = binding.sessionId
      const root =
        options.authoringRoot?.(sessionId) ??
        join(getClaudeConfigHomeDir(), 'dev-mods', sessionId)
      let expanded = false
      for (let attempt = 0; attempt < 3; attempt++) {
        signal.throwIfAborted()
        if (!authoringRequestIsCurrent(sessionId, generation, signal))
          return { enabled: false }
        const timing = runtime?.activePublicTurnId
          ? 'when this turn ends'
          : 'now'
        const message = expanded
          ? [
              `Mods live in this session's folder (${root}).`,
              'A mod is code Claude wrote; it runs with your permissions.',
              `Enable: they load ${timing} and reload when their files change.`,
              'Enable holds for this session, also after a restart.',
              'Not now: they stay unloaded until this session next starts.',
              '/plugin lists what loaded and turns it off.',
            ].join('\n')
          : `Enable hot reloading for this session?\n\nMods in this session's folder (${root}) load ${timing} and reload when their files change. They run with your permissions.`
        const response = await requestPrompt(
          {
            prompt: 'mod_hot_reload',
            message,
            options: [
              { key: 'explain', label: 'How does this work?' },
              { key: 'enable', label: 'Enable for this session' },
              { key: 'decline', label: 'Not now' },
            ],
          },
          signal,
        )
        signal.throwIfAborted()
        if (!authoringRequestIsCurrent(sessionId, generation, signal))
          return { enabled: false }
        if (response.selected === 'explain') {
          expanded = true
          continue
        }
        authoringRetryPending = false
        if (response.selected !== 'enable') return { enabled: false }
        return await enableAuthoring(root, sessionId, generation, signal)
          ? { enabled: true, root }
          : { enabled: false }
      }
      return { enabled: false }
    })()
    authoringConsent = consent
    try {
      return await consent
    } catch (error) {
      if (signal.aborted || error instanceof ModAuthoringPromptDismissedError) {
        authoringRetryPending = true
      } else {
        diagnostic({
          plugin: 'host',
          stage: 'authoring-consent',
          message: `Unable to request Mod authoring consent: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
      throw error
    } finally {
      if (authoringConsent === consent) authoringConsent = undefined
    }
  }

  function scheduleAuthoringRetry() {
    if (authoringRetry || !authoringRetryPending || !authoringPrompt || stopped || !binding?.isInteractive)
      return
    authoringRetryPending = false
    const prompt = authoringPrompt
    const signal = authoringController.signal
    const retry = requestAuthoringConsent(prompt, signal)
      .then(() => {})
      .catch(error => {
        if (signal.aborted || error instanceof ModAuthoringPromptDismissedError) return
        diagnostic({
          plugin: 'host',
          stage: 'authoring-consent',
          message: `Unable to request Mod authoring consent: ${error instanceof Error ? error.message : String(error)}`,
        })
      })
      .finally(() => {
        if (authoringRetry === retry) authoringRetry = undefined
      })
    authoringRetry = retry
  }

  function dispose(): Promise<void> {
    if (disposal) return disposal
    stopped = true
    publishRender()
    unsubscribeRender?.()
    renderListeners.clear()
    for (const listener of commandListeners) listener()
    authoringGeneration++
    authoringConsent = undefined
    authoringPrompt = undefined
    authoringRetryPending = false
    authoringController.abort(new Error('Mods session disposed'))
    authoringPending = false
    receiveController.abort(new Error('Mods session disposed'))
    firstBinding.resolve()
    if (timer) clearTimeout(timer)
    timer = undefined
    unsubscribeUsage?.()
    unsubscribeSettings?.()
    unsubscribePlugins?.()
    unsubscribeOptions?.()
    setQueueRecordRewriter(undefined)
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
          diagnosticSecrets.clear()
          unsubscribePlaced?.()
          unsubscribeUi?.()
          uiListeners.clear()
          unsubscribeCommands?.()
          commandListeners.clear()
          unsubscribeAgents?.()
          unsubscribeTools?.()
          toolListeners.clear()
          unregisterShutdown?.()
          unregisterCleanup?.()
        }
      }
    })()
    return disposal
  }

  return {
    commands,
    isDiffOwned: () => !stopped && (runtime?.isDiffOwned() ?? false),
    tools,
    ui,
    renderHooks,
    get runtime() {
      return stopped ? undefined : runtime
    },
    /** A service an earlier bind installed, so a nested host (QueryEngine under print) can keep it. */
    hostService<K extends keyof ModHostServices>(key: K): ModHostServices[K] {
      return services[key]
    },
    /** Await before processing a prompt, including slash commands that fork. */
    async bind(next: ModBinding, updateState?: SetAppState, hostServices?: ModHostServices): Promise<void> {
      if (stopped || !options.isTrusted) return
      if (hostServices) {
        const { configRows, ...rest } = hostServices
        if (configRows) builtinConfigRows = configRows
        const firstDiagnosticHost = !services.uiDiagnostic && rest.uiDiagnostic
        Object.assign(services, rest)
        // Diagnostics from before the TUI bound (module load) went to stderr under the startup screen.
        // A headless load failure already took its own route, which never reaches uiDiagnostic.
        if (firstDiagnosticHost) {
          const headless = !next.isInteractive
          for (const shown of diagnostics) {
            if (shown.type !== 'generic-error' || (headless && shown.error.startsWith('load: '))) continue
            firstDiagnosticHost(shown.plugin ?? 'host', shown.error)
          }
        }
        if (services.uiLog && pendingLoadLogs.length > 0) {
          const pending = pendingLoadLogs
          pendingLoadLogs = []
          for (const { plugin, text } of pending) services.uiLog(plugin, text, 'transcript')
        }
      }
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
        authoringGeneration++
        authoringConsent = undefined
        authoringPrompt = undefined
        authoringRetryPending = false
        authoringController.abort(new Error('Mods session changed'))
        authoringController = new AbortController()
        authoringRoot = undefined
        authoringEnabled = false
        authoringPending = false
        authoringPlugins.clear()
      }
      binding = next
      const authoringRestoreRequested = authoringRestorePending
      if (authoringRestorePending) {
        const expected =
          options.authoringRoot?.(next.sessionId) ??
          join(getClaudeConfigHomeDir(), 'dev-mods', next.sessionId)
        if (restoredAuthoringRoot === expected) {
          authoringRoot = restoredAuthoringRoot
          authoringEnabled = true
        }
        restoredAuthoringRoot = undefined
        authoringRestorePending = false
      }
      if (changed) runtimeBound = false
      const first = !initialized
      initialize()
      try {
        if (first || timer || authoringRestoreRequested) await refresh()
        else if (runtime)
          await enqueue(async () => {
            await runtime!.bind(next)
            runtimeBound = true
          })
        else await queue
      } finally {
        // A failed first refresh must not hold inbound messages forever.
        firstBinding.resolve()
      }
      publishAgents()
    },
    async receive(input: SessionReceiveInput, admit: (input: SessionReceiveInput) => void | SessionReceiveResult | Promise<void | SessionReceiveResult>, signal?: AbortSignal) {
      const lifetime = receiveController.signal
      const combined = createCombinedAbortSignal(signal, { signalB: lifetime })
      let abort: (() => void) | undefined
      let snapshot: ReturnType<ModsRuntime['capture']> | undefined
      try {
        combined.signal.throwIfAborted()
        // A disabled host (remote/SSH) never binds, so there is no runtime to wait for.
        if (options.isTrusted && !options.getDisabledReason?.()) {
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
    requestAuthoringConsent,
    async finishTurn(): Promise<void> {
      if (authoringPending) {
        authoringPending = false
        await refresh()
      }
      scheduleAuthoringRetry()
    },
    restoreAuthoringConsent(root: string | undefined): void {
      restoredAuthoringRoot = root
      authoringRestorePending = true
      if (!root) {
        authoringRoot = undefined
        authoringEnabled = false
        authoringPending = false
        authoringPlugins.clear()
      }
    },
    refresh,
    dispose,
  }
}

export type ModsSession = ReturnType<typeof createModsSession>
