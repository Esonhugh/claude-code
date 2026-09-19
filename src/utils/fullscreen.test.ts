import { afterEach, expect, test } from 'bun:test'
import {
  getFullscreenModeSource,
  initializeFullscreenMode,
  isFullscreenEnvEnabled,
} from './fullscreen.js'

const originalEnv = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnv }
  initializeFullscreenMode(undefined)
})

test('uses the renderer selected at startup without hot-switching settings', () => {
  delete process.env.CLAUDE_CODE_NO_FLICKER
  delete process.env.TMUX
  const settings = { tui: 'fullscreen' as 'fullscreen' | 'default' }
  initializeFullscreenMode(settings.tui)
  expect(isFullscreenEnvEnabled()).toBe(true)
  settings.tui = 'default'
  expect(isFullscreenEnvEnabled()).toBe(true)
  initializeFullscreenMode(settings.tui)
  expect(isFullscreenEnvEnabled()).toBe(false)
})

test('explicit environment overrides the startup setting in both directions', () => {
  initializeFullscreenMode('fullscreen')
  process.env.CLAUDE_CODE_NO_FLICKER = 'false'
  expect(isFullscreenEnvEnabled()).toBe(false)
  expect(getFullscreenModeSource()).toBe('CLAUDE_CODE_NO_FLICKER')
  initializeFullscreenMode('default')
  process.env.CLAUDE_CODE_NO_FLICKER = 'true'
  expect(isFullscreenEnvEnabled()).toBe(true)
  delete process.env.CLAUDE_CODE_NO_FLICKER
  expect(isFullscreenEnvEnabled()).toBe(false)
  expect(getFullscreenModeSource()).toContain('tui setting')
})
