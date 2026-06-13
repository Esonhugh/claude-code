import type { SettingsJson } from '../../utils/settings/types.js'

export const DEFAULT_UI_NAME = 'EsonClaw'

export function getConfiguredUiName(settings: Pick<SettingsJson, 'uiName'>): string {
  const uiName = settings.uiName?.trim()
  return uiName || DEFAULT_UI_NAME
}
