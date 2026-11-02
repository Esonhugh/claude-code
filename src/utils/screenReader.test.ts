import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const root = mkdtempSync(join(tmpdir(), 'screen-reader-'))
const previousConfig = process.env.CLAUDE_CONFIG_DIR
const previousEnv = process.env.CLAUDE_AX_SCREEN_READER
process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
delete process.env.CLAUDE_AX_SCREEN_READER

const { initScreenReaderMode, screenReaderStatusLine } = await import('./screenReader.js')
const { isScreenReaderEnabled, setScreenReaderEnabled } = await import('../ink/screen-reader.js')
const { resetSettingsCache } = await import('./settings/settingsCache.js')

afterAll(() => {
  setScreenReaderEnabled(false)
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  if (previousEnv === undefined) delete process.env.CLAUDE_AX_SCREEN_READER
  else process.env.CLAUDE_AX_SCREEN_READER = previousEnv
  rmSync(root, { recursive: true, force: true })
})

function userSettings(value: unknown) {
  mkdirSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true })
  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), JSON.stringify(value))
  resetSettingsCache()
}

test('screen-reader mode turns on from the flag, the env var or user settings, like 2.1.311', () => {
  userSettings({})
  initScreenReaderMode(['claude'])
  expect(isScreenReaderEnabled()).toBe(false)
  expect(screenReaderStatusLine()).toBeNull()

  initScreenReaderMode(['claude', '--ax-screen-reader'])
  expect(screenReaderStatusLine()).toBe('[Screen Reader Mode: on via flag]')
  initScreenReaderMode(['claude', '--', '--ax-screen-reader'])
  expect(isScreenReaderEnabled()).toBe(false)

  userSettings({ axScreenReader: true })
  initScreenReaderMode(['claude'])
  expect(screenReaderStatusLine()).toBe('[Screen Reader Mode: on via settings]')

  process.env.CLAUDE_AX_SCREEN_READER = '0'
  initScreenReaderMode(['claude'])
  expect(isScreenReaderEnabled()).toBe(false)
  process.env.CLAUDE_AX_SCREEN_READER = '1'
  userSettings({})
  initScreenReaderMode(['claude'])
  expect(screenReaderStatusLine()).toBe('[Screen Reader Mode: on via env]')
  delete process.env.CLAUDE_AX_SCREEN_READER
})
