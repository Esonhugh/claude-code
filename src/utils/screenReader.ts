import { isScreenReaderEnabled, setScreenReaderEnabled } from '../ink/screen-reader.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'
import { isSettingSourceEnabled } from './settings/constants.js'
import { getSettingsForSource } from './settings/settings.js'

export type ScreenReaderSource = 'flag' | 'env' | 'settings'

let source: ScreenReaderSource | undefined

/**
 * --ax-screen-reader, then CLAUDE_AX_SCREEN_READER, then axScreenReader in
 * user, managed or --settings settings (project and local settings cannot
 * turn it on), like 2.1.311. Call once settings are loaded, before the first render.
 */
export function initScreenReaderMode(argv: string[] = process.argv): void {
  const separator = argv.indexOf('--')
  const args = separator === -1 ? argv : argv.slice(0, separator)
  const env = process.env.CLAUDE_AX_SCREEN_READER
  if (args.includes('--ax-screen-reader')) source = 'flag'
  else if (isEnvTruthy(env)) source = 'env'
  else if (isEnvDefinedFalsy(env)) source = undefined
  else if (
    (['userSettings', 'policySettings', 'flagSettings'] as const).some(
      s => isSettingSourceEnabled(s) && getSettingsForSource(s)?.axScreenReader === true,
    )
  ) source = 'settings'
  else source = undefined
  setScreenReaderEnabled(source !== undefined)
}

/** The startup line official prints first in screen-reader mode, or null when it is off. */
export function screenReaderStatusLine(): string | null {
  if (!isScreenReaderEnabled()) return null
  return source ? `[Screen Reader Mode: on via ${source}]` : '[Screen Reader Mode: on]'
}
