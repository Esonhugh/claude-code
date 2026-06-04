import type { SystemTheme } from './systemTheme.js'
import { getSystemThemeName } from './systemTheme.js'

export function watchSystemTheme(
  _queryTerminal: unknown,
  onThemeChange: (theme: SystemTheme) => void,
): () => void {
  onThemeChange(getSystemThemeName())
  return () => {}
}
