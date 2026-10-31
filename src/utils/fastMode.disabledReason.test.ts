import { afterEach, expect, test } from 'bun:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const saved = process.env.CLAUDE_CODE_DISABLE_FAST_MODE
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CODE_DISABLE_FAST_MODE
  else process.env.CLAUDE_CODE_DISABLE_FAST_MODE = saved
})

test('fast mode disabled by env reports the official SDK reason code', async () => {
  process.env.CLAUDE_CODE_DISABLE_FAST_MODE = '1'
  const { getFastModeDisabledReason, getFastModeUnavailableReason } =
    await import('./fastMode.js')
  expect(getFastModeDisabledReason()).toBe('disabled_by_env')
  expect(getFastModeUnavailableReason()).toBe('Fast mode is not available')
})
