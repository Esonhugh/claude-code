import { checkHasTrustDialogAccepted } from '../config.js'
import { getSettingsFilePathForSource } from './settings.js'

/**
 * Whether settings, agents and other definitions from this source may act for
 * the user. Project and local sources are files inside the workspace folder,
 * so they need that folder to be trusted. This holds in -p and SDK sessions
 * too, which never show the trust dialog. At home with the default config
 * dir, .claude/settings.json is the user's own settings file.
 */
export function isSettingSourceWorkspaceTrusted(
  source: string | undefined,
): boolean {
  return (
    (source !== 'projectSettings' && source !== 'localSettings') ||
    checkHasTrustDialogAccepted() ||
    getSettingsFilePathForSource('projectSettings') ===
      getSettingsFilePathForSource('userSettings')
  )
}
