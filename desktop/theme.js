import { readFileSync, renameSync, writeFileSync } from 'node:fs'

// The page's appearance setting (web/src/App.tsx `claude-web-theme`), as Electron's nativeTheme.themeSource.
export const THEME_MODES = ['system', 'light', 'dark']
export const isThemeMode = mode => THEME_MODES.includes(mode)

/** The saved mode; 'system' when the file is missing, unreadable or holds something else. */
export function readThemeMode(file) {
  try {
    const { theme } = JSON.parse(readFileSync(file, 'utf8'))
    return isThemeMode(theme) ? theme : 'system'
  } catch {
    return 'system'
  }
}

export function writeThemeMode(file, mode) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ theme: mode })}\n`)
  renameSync(tmp, file)
}
