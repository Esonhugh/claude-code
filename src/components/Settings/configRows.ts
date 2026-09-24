import { feature } from 'bun:bundle'
import type { AppState } from '../../state/AppStateStore.js'
import type { ModConfigRowProvider, ModConfigValue } from '../../services/mods/config.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import { setUserMsgOptIn } from '../../bootstrap/state.js'
import { isBridgeEnabled } from '../../bridge/bridgeEnabled.js'
import { DEFAULT_OUTPUT_STYLE_NAME } from '../../constants/outputStyles.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import {
  getAutoUpdaterDisabledReason,
  getCurrentProjectConfig,
  getGlobalConfig,
  getRemoteControlAtStartup,
  saveGlobalConfig,
  type GlobalConfig,
} from '../../utils/config.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { normalizeApiKeyForConfig } from '../../utils/authPortable.js'
import { isEnvTruthy, isRunningOnHomespace } from '../../utils/envUtils.js'
import {
  clearFastModeCooldown,
  FAST_MODE_MODEL_DISPLAY,
  getFastModeModel,
  isFastModeAvailable,
  isFastModeEnabled,
  isFastModeSupportedByModel,
} from '../../utils/fastMode.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import { hasAccessToIDEExtensionDiffFeature, isSupportedTerminal } from '../../utils/ide.js'
import { modelDisplayString } from '../../utils/model/model.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { EXTERNAL_PERMISSION_MODES, PERMISSION_MODES, type PermissionMode } from '../../utils/permissions/PermissionMode.js'
import { getAutoModeEnabledState, hasAutoModeOptInAnySource, transitionPlanAutoMode } from '../../utils/permissions/permissionSetup.js'
import { isPlanModeAvailable } from '../../utils/planModeV2.js'
import { getInitialSettings, getSettingsForSource, updateSettingsForSource } from '../../utils/settings/settings.js'
import type { EditableSettingSource } from '../../utils/settings/constants.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import { clearCliTeammateModeOverride, getCliTeammateModeOverride } from '../../utils/swarm/backends/teammateModeSnapshot.js'
import { THEME_NAMES, type ThemeSetting } from '../../utils/theme.js'
import { isAnt } from '../../utils/userType.js'

type Context = {
  getAppState: () => AppState
  setAppState: (updater: (state: AppState) => AppState) => void
  options?: {
    mcpClients?: MCPServerConnection[]
    setTheme?: (theme: ThemeSetting) => void
    hasExternalIncludes?: boolean
    /** Already normalized by the caller; never pass the actual API key. */
    customApiKeySuffix?: string
  }
}

type Row = Omit<ModConfigRowProvider, 'provider' | 'isLocked'>

export function getConfigRows(context: Context): ModConfigRowProvider[] {
  const global = getGlobalConfig()
  const settings = getInitialSettings()
  const state = context.getAppState()
  const options = context.options
  const customApiKeySuffix = options?.customApiKeySuffix ?? (
    process.env.ANTHROPIC_API_KEY && !isRunningOnHomespace()
      ? normalizeApiKeyForConfig(process.env.ANTHROPIC_API_KEY)
      : undefined
  )
  const showAutoMode = feature('TRANSCRIPT_CLASSIFIER')
    ? hasAutoModeOptInAnySource() || getAutoModeEnabledState() === 'enabled'
    : false
  const showDefaultView = feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (require('../../tools/BriefTool/BriefTool.js') as typeof import('../../tools/BriefTool/BriefTool.js')).isBriefEntitled()
    : false

  function writeSettings(source: EditableSettingSource, patch: SettingsJson): void {
    const result = updateSettingsForSource(source, patch)
    if (result.error) throw result.error
    context.setAppState(current => ({ ...current, settings: getInitialSettings() }))
  }

  function globalBoolean(key: keyof GlobalConfig, label: string, value: boolean): Row {
    return {
      key, label, kind: 'boolean', value,
      set(value) { saveGlobalConfig(current => ({ ...current, [key]: value })) },
    }
  }

  const permissionOptions: PermissionMode[] = ['default', 'plan']
  for (const mode of feature('TRANSCRIPT_CLASSIFIER') ? PERMISSION_MODES : EXTERNAL_PERMISSION_MODES) {
    if (!permissionOptions.includes(mode) && mode !== 'bypassPermissions' && (mode !== 'auto' || showAutoMode)) {
      permissionOptions.push(mode)
    }
  }
  const rows: Row[] = [
    { ...globalBoolean('autoCompactEnabled', 'Auto-compact', global.autoCompactEnabled), key: 'autoCompact' },
    {
      key: 'tips', label: 'Show tips', kind: 'boolean',
      value: settings.spinnerTipsEnabled ?? true,
      set(value) { writeSettings('localSettings', { spinnerTipsEnabled: value as boolean }) },
    },
    {
      key: 'prefersReducedMotion', label: 'Reduce motion', kind: 'boolean',
      value: settings.prefersReducedMotion ?? false,
      set(value) { writeSettings('localSettings', { prefersReducedMotion: value as boolean }) },
    },
    {
      key: 'thinkingEnabled', label: 'Thinking mode', kind: 'boolean',
      value: state.thinkingEnabled ?? true,
      set(value) {
        writeSettings('userSettings', { alwaysThinkingEnabled: value ? undefined : false })
        context.setAppState(current => ({ ...current, thinkingEnabled: value as boolean }))
      },
    },
    ...(isFastModeEnabled() && isFastModeAvailable() ? [{
      key: 'fastMode', label: getAPIProvider() === 'openai' ? 'Fast mode' : `Fast mode (${FAST_MODE_MODEL_DISPLAY} only)`,
      kind: 'boolean' as const, value: !!state.fastMode,
      set(value: ModConfigValue) {
        writeSettings('userSettings', { fastMode: value ? true : undefined })
        clearFastModeCooldown()
        context.setAppState(current => ({
          ...current,
          ...(value && !isFastModeSupportedByModel(current.mainLoopModel)
            ? { mainLoopModel: getFastModeModel(), mainLoopModelForSession: null } : {}),
          fastMode: value as boolean,
        }))
      },
    }] : []),
    ...(getFeatureValue_CACHED_MAY_BE_STALE('tengu_chomp_inflection', false) ? [{
      key: 'promptSuggestionEnabled', label: 'Prompt suggestions', kind: 'boolean' as const,
      value: state.promptSuggestionEnabled,
      set(value: ModConfigValue) {
        writeSettings('userSettings', { promptSuggestionEnabled: value ? undefined : false })
        context.setAppState(current => ({ ...current, promptSuggestionEnabled: value as boolean }))
      },
    }] : []),
    ...(isAnt() ? [globalBoolean('speculationEnabled', 'Speculative execution', global.speculationEnabled ?? true)] : []),
    ...(!isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING)
      ? [globalBoolean('fileCheckpointingEnabled', 'Rewind code (checkpoints)', global.fileCheckpointingEnabled)] : []),
    {
      key: 'verbose', label: 'Verbose output', kind: 'boolean', value: state.verbose,
      set(value) {
        saveGlobalConfig(current => ({ ...current, verbose: value as boolean }))
        context.setAppState(current => ({ ...current, verbose: value as boolean }))
      },
    },
    globalBoolean('terminalProgressBarEnabled', 'Terminal progress bar', global.terminalProgressBarEnabled),
    ...(getFeatureValue_CACHED_MAY_BE_STALE('tengu_terminal_sidebar', false)
      ? [globalBoolean('showStatusInTerminalTab', 'Show status in terminal tab', global.showStatusInTerminalTab ?? false)] : []),
    globalBoolean('showTurnDuration', 'Show turn duration', global.showTurnDuration),
    {
      key: 'defaultPermissionMode', label: 'Default permission mode', kind: 'choice',
      value: settings.permissions?.defaultMode || 'default',
      options: permissionOptions.filter(mode => mode !== 'plan' || isPlanModeAvailable()),
      set(value) {
        writeSettings('userSettings', { permissions: { defaultMode: value as (typeof PERMISSION_MODES)[number] } })
      },
    },
    ...(showAutoMode ? [{
      key: 'useAutoModeDuringPlan', label: 'Use auto mode during plan', kind: 'boolean' as const,
      value: settings.useAutoModeDuringPlan ?? true,
      set(value: ModConfigValue) {
        writeSettings('userSettings', { useAutoModeDuringPlan: value as boolean })
        context.setAppState(current => ({ ...current, toolPermissionContext: transitionPlanAutoMode(current.toolPermissionContext) }))
      },
    }] : []),
    globalBoolean('respectGitignore', 'Respect .gitignore in file picker', global.respectGitignore),
    globalBoolean('copyFullResponse', 'Always copy full response (skip /copy picker)', global.copyFullResponse),
    ...(isFullscreenEnvEnabled() ? [globalBoolean('copyOnSelect', 'Copy on select', global.copyOnSelect ?? true)] : []),
    {
      key: 'autoUpdatesChannel', label: 'Auto-update channel', kind: 'text',
      value: getAutoUpdaterDisabledReason() ? 'disabled' : settings.autoUpdatesChannel ?? 'latest',
    },
    {
      key: 'theme', label: 'Theme', kind: 'choice', value: global.theme,
      options: feature('AUTO_THEME') ? ['auto', ...THEME_NAMES] : THEME_NAMES,
      set(value) {
        saveGlobalConfig(current => ({ ...current, theme: value as ThemeSetting }))
        options?.setTheme?.(value as ThemeSetting)
      },
    },
    {
      key: 'notifChannel', label: feature('KAIROS') || feature('KAIROS_PUSH_NOTIFICATION') ? 'Local notifications' : 'Notifications',
      kind: 'choice', value: global.preferredNotifChannel,
      options: ['auto', 'iterm2', 'terminal_bell', 'iterm2_with_bell', 'kitty', 'ghostty', 'notifications_disabled'],
      set(value) { saveGlobalConfig(current => ({ ...current, preferredNotifChannel: value as GlobalConfig['preferredNotifChannel'] })) },
    },
    ...(feature('KAIROS') || feature('KAIROS_PUSH_NOTIFICATION') ? [
      globalBoolean('taskCompleteNotifEnabled', 'Push when idle', global.taskCompleteNotifEnabled ?? false),
      globalBoolean('inputNeededNotifEnabled', 'Push when input needed', global.inputNeededNotifEnabled ?? false),
      globalBoolean('agentPushNotifEnabled', 'Push when Claude decides', global.agentPushNotifEnabled ?? false),
    ] : []),
    { key: 'outputStyle', label: 'Output style', kind: 'text', value: settings.outputStyle || DEFAULT_OUTPUT_STYLE_NAME },
    ...(showDefaultView ? [{
      key: 'defaultView', label: 'What you see by default', kind: 'choice' as const,
      value: settings.defaultView === undefined ? 'default' : String(settings.defaultView),
      options: ['transcript', 'chat', 'default'],
      set(value: ModConfigValue) {
        writeSettings('localSettings', { defaultView: value === 'default' ? undefined : value as 'chat' | 'transcript' })
        context.setAppState(current => ({ ...current, isBriefOnly: value === 'chat' }))
        setUserMsgOptIn(value === 'chat')
      },
    }] : []),
    { key: 'language', label: 'Language', kind: 'text', value: settings.language ?? 'Default (English)' },
    {
      key: 'editorMode', label: 'Editor mode', kind: 'choice',
      value: global.editorMode === 'emacs' ? 'normal' : global.editorMode || 'normal',
      options: ['normal', 'vim'],
      set(value) { saveGlobalConfig(current => ({ ...current, editorMode: value as GlobalConfig['editorMode'] })) },
    },
    globalBoolean('prStatusFooterEnabled', 'Show PR status footer', global.prStatusFooterEnabled ?? true),
    { key: 'model', label: 'Model', kind: 'text', value: state.mainLoopModel ?? 'Default (recommended)' },
    ...(hasAccessToIDEExtensionDiffFeature(options?.mcpClients ?? []) ? [{
      key: 'diffTool', label: 'Diff tool', kind: 'choice' as const,
      value: global.diffTool ?? 'auto', options: ['terminal', 'auto'],
      set(value: ModConfigValue) { saveGlobalConfig(current => ({ ...current, diffTool: value as GlobalConfig['diffTool'] })) },
    }] : []),
    ...(isSupportedTerminal()
      ? [globalBoolean('autoInstallIdeExtension', 'Auto-install IDE extension', global.autoInstallIdeExtension ?? true)]
      : [globalBoolean('autoConnectIde', 'Auto-connect to IDE (external terminal)', global.autoConnectIde ?? false)]),
    globalBoolean('claudeInChromeDefaultEnabled', 'Claude in Chrome enabled by default', global.claudeInChromeDefaultEnabled ?? true),
    ...(isAgentSwarmsEnabled() ? [
      {
        key: 'teammateMode', label: getCliTeammateModeOverride() ? `Teammate mode [overridden: ${getCliTeammateModeOverride()}]` : 'Teammate mode',
        kind: 'choice' as const, value: global.teammateMode ?? 'auto', options: ['auto', 'tmux', 'in-process'],
        set(value: ModConfigValue) {
          const mode = value as 'auto' | 'tmux' | 'in-process'
          saveGlobalConfig(current => ({ ...current, teammateMode: mode }))
          clearCliTeammateModeOverride(mode)
        },
      },
      {
        key: 'teammateDefaultModel', label: 'Default teammate model', kind: 'text' as const,
        value: global.teammateDefaultModel === undefined ? 'Auto (explicit leader model, otherwise provider default)'
          : global.teammateDefaultModel === null ? "Inherit leader's model" : modelDisplayString(global.teammateDefaultModel),
      },
    ] : []),
    ...(feature('BRIDGE_MODE') && isBridgeEnabled() ? [{
      key: 'remoteControlAtStartup', label: 'Enable Remote Control for all sessions', kind: 'choice' as const,
      value: global.remoteControlAtStartup === undefined ? 'default' : String(global.remoteControlAtStartup),
      options: ['true', 'false', 'default'],
      set(value: ModConfigValue) {
        saveGlobalConfig(current => {
          const next = { ...current }
          if (value === 'default') delete next.remoteControlAtStartup
          else next.remoteControlAtStartup = value === 'true'
          return next
        })
        context.setAppState(current => ({ ...current, replBridgeEnabled: getRemoteControlAtStartup(), replBridgeOutboundOnly: false }))
      },
    }] : []),
    ...(options?.hasExternalIncludes ? [{
      key: 'showExternalIncludesDialog', label: 'External CLAUDE.md includes', kind: 'text' as const,
      value: String(!!getCurrentProjectConfig().hasClaudeMdExternalIncludesApproved),
    }] : []),
    ...(customApiKeySuffix ? [{
      key: 'apiKey', label: 'Use custom API key', kind: 'boolean' as const,
      value: global.customApiKeyResponses?.approved?.includes(customApiKeySuffix) ?? false,
      set(value: ModConfigValue) {
        const suffix = customApiKeySuffix
        saveGlobalConfig(current => ({
          ...current,
          customApiKeyResponses: {
            ...current.customApiKeyResponses,
            approved: [...(current.customApiKeyResponses?.approved ?? []).filter(key => key !== suffix), ...(value ? [suffix] : [])],
            rejected: [...(current.customApiKeyResponses?.rejected ?? []).filter(key => key !== suffix), ...(value ? [] : [suffix])],
          },
        }))
      },
    }] : []),
  ]

  function policyValue(key: string): unknown {
    const policy = getSettingsForSource('policySettings')
    if (key === 'autoCompact') return policy?.autoCompactEnabled
    if (key === 'tips') return policy?.spinnerTipsEnabled
    if (key === 'defaultPermissionMode') return policy?.permissions?.defaultMode
    if (key === 'thinkingEnabled') return policy?.alwaysThinkingEnabled
    if (key === 'notifChannel') return policy?.preferredNotifChannel
    return policy?.[key]
  }

  return rows.map(row => {
    const lockedValue = policyValue(row.key)
    const validate = (value: ModConfigValue): string | undefined => {
      if (row.kind === 'boolean' ? typeof value !== 'boolean'
        : row.kind === 'choice' ? typeof value !== 'string' || !row.options?.includes(value)
        : typeof value !== 'string') return `Invalid value for ${row.key} (${row.kind})`
      return undefined
    }
    return {
      ...row,
      ...(typeof lockedValue === typeof row.value ? { value: lockedValue as ModConfigValue } : {}),
      provider: { plugin: 'engine', tier: 'core' },
      isLocked: lockedValue !== undefined,
      ...(row.set ? {
        validate,
        set(value: ModConfigValue) {
          if (policyValue(row.key) !== undefined) throw new Error(`Config setting is locked by policySettings: ${row.key}`)
          const error = validate(value)
          if (error) throw new TypeError(error)
          return row.set!(value)
        },
      } : {}),
    }
  })
}
