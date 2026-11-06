import { type GlobalConfig, getGlobalConfig, saveGlobalConfig } from '../config.js'
import { logForDebugging } from '../debug.js'
import { getSettingsForSource, updateSettingsForSource } from './settings.js'
import type { SettingsJson } from './types.js'

/**
 * /config preferences official Claude Code (2.1.318) moved from ~/.claude.json
 * into ~/.claude/settings.json, where it now reads and writes them. This build
 * still reads ~/.claude.json, so the two are kept in step: settings.json wins
 * at startup and every change here is written to both.
 */
export const UI_PREF_KEYS = [
  'theme',
  'editorMode',
  'preferredNotifChannel',
  'verbose',
  'autoCompactEnabled',
  'fileCheckpointingEnabled',
  'showTurnDuration',
  'terminalProgressBarEnabled',
  'todoFeatureEnabled',
  'inputNeededNotifEnabled',
  'agentPushNotifEnabled',
  'remoteControlAtStartup',
] as const satisfies readonly (keyof GlobalConfig & keyof SettingsJson)[]

type UiPrefs = Partial<Pick<GlobalConfig, (typeof UI_PREF_KEYS)[number]>>

/** At startup: take the values official Claude Code (or the user) saved in settings.json. */
export function syncUiPrefsFromUserSettings(): void {
  const settings = getSettingsForSource('userSettings')
  const config = getGlobalConfig()
  const prefs: Record<string, unknown> = {}
  for (const key of UI_PREF_KEYS) {
    const value = settings?.[key]
    if (value === undefined || value === config[key]) continue
    if (key === 'theme' && !isThemeSetting(value as string)) continue
    prefs[key] = value
  }
  if (Object.keys(prefs).length === 0) return
  saveGlobalConfig(current => ({ ...current, ...(prefs as UiPrefs) }))
}

// THEME_SETTINGS in ../theme.js, not imported: it would pull the theme
// watcher into config.ts. An official-only theme name is skipped.
function isThemeSetting(value: string): boolean {
  return /^(auto|(light|dark)(-daltonized|-ansi)?)$/.test(value) || value.startsWith('custom:')
}

export function mirrorUiPrefsToUserSettings(
  before: GlobalConfig,
  after: GlobalConfig,
): void {
  const settings = getSettingsForSource('userSettings')
  const patch: Record<string, unknown> = {}
  for (const key of UI_PREF_KEYS) {
    if (after[key] !== before[key] && after[key] !== settings?.[key]) {
      patch[key] = after[key]
    }
  }
  if (Object.keys(patch).length === 0) return
  const { error } = updateSettingsForSource('userSettings', patch as SettingsJson)
  if (error) logForDebugging(`Could not save /config preferences to settings.json: ${error.message}`)
}
