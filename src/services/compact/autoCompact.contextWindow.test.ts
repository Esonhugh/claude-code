import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const settings = await import('../../utils/settings/settings.js')
const getSettings = spyOn(settings, 'getInitialSettings').mockReturnValue({
  autoCompactWindow: 150_000,
})
const { getEffectiveContextWindowSize } = await import('./autoCompact.js')

const previousAutoCompactWindow =
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW

afterEach(() => {
  getSettings.mockReturnValue({ autoCompactWindow: 150_000 })
  delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
})

afterAll(() => {
  getSettings.mockRestore()
  if (previousAutoCompactWindow === undefined)
    delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  else
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = previousAutoCompactWindow
})

test('uses the configured auto compact window in the production threshold', () => {
  expect(getEffectiveContextWindowSize('custom-model')).toBe(145_904)

  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '180k'
  expect(getEffectiveContextWindowSize('custom-model')).toBe(175_904)
})
