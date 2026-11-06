import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { GlobalConfig } from '../config.js'

let userSettings: Record<string, unknown> | undefined
let config: Record<string, unknown>
const settingsWrites: Record<string, unknown>[] = []
mock.module('./settings.js', () => ({
  getSettingsForSource: () => userSettings,
  updateSettingsForSource: (_source: string, patch: Record<string, unknown>) => {
    settingsWrites.push(patch)
    return { error: null }
  },
}))
mock.module('../config.js', () => ({
  getGlobalConfig: () => config,
  saveGlobalConfig: (updater: (current: GlobalConfig) => GlobalConfig) => {
    config = updater(config as GlobalConfig)
  },
}))

const { mirrorUiPrefsToUserSettings, syncUiPrefsFromUserSettings } = await import('./uiPrefs.js')

beforeEach(() => {
  userSettings = undefined
  config = { theme: 'dark', verbose: false, autoCompactEnabled: true, numStartups: 3 }
  settingsWrites.length = 0
})

describe('/config preferences shared with official Claude Code', () => {
  test('values official saved in settings.json win at startup', () => {
    userSettings = { verbose: true, autoCompactEnabled: true, theme: 'light-ansi', model: 'opus' }
    syncUiPrefsFromUserSettings()
    expect(config).toEqual({ theme: 'light-ansi', verbose: true, autoCompactEnabled: true, numStartups: 3 })
  })

  test('a theme only official knows is not copied', () => {
    userSettings = { theme: 'some-new-official-theme' }
    syncUiPrefsFromUserSettings()
    expect(config.theme).toBe('dark')
  })

  test('changes here are written to settings.json too, other keys are not', () => {
    userSettings = { autoCompactEnabled: true }
    const before = config as GlobalConfig
    mirrorUiPrefsToUserSettings(before, { ...before, autoCompactEnabled: false, numStartups: 4 } as GlobalConfig)
    expect(settingsWrites).toEqual([{ autoCompactEnabled: false }])
    mirrorUiPrefsToUserSettings(before, { ...before, numStartups: 5 } as GlobalConfig)
    expect(settingsWrites).toHaveLength(1)
  })
})
