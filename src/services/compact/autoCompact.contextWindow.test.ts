import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const settings = await import('../../utils/settings/settings.js')
const getSettings = spyOn(settings, 'getInitialSettings').mockReturnValue({
  autoCompactWindow: 150_000,
})
const api = await import('../api/claude.js')
// This test isolates window selection from provider/model output limits.
const maxOutput = spyOn(api, 'getMaxOutputTokensForModel').mockReturnValue(4096)
const config = await import('../../utils/config.js')
const globalConfig = spyOn(config, 'getGlobalConfig').mockReturnValue({ autoCompactEnabled: true } as ReturnType<typeof config.getGlobalConfig>)
const { getEffectiveContextWindowSize, getAutoCompactThreshold, getAutoCompactState } = await import('./autoCompact.js')

const previousAutoCompactWindow =
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW

afterEach(() => {
  getSettings.mockReturnValue({ autoCompactWindow: 150_000 })
  delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
})

afterAll(() => {
  getSettings.mockRestore()
  maxOutput.mockRestore()
  globalConfig.mockRestore()
  if (previousAutoCompactWindow === undefined)
    delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  else
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = previousAutoCompactWindow
})

test('uses the configured auto compact window in the production threshold', () => {
  expect(getEffectiveContextWindowSize('custom-model')).toBe(145_904)

  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '180000'
  expect(getEffectiveContextWindowSize('custom-model')).toBe(175_904)
  // Official environment parsing takes the integer prefix, then clamps to 100K.
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '180k'
  expect(getEffectiveContextWindowSize('custom-model')).toBe(95_904)
  expect(getAutoCompactThreshold('custom-model')).toBe(82_904)
})

// Exercise the production enforcement selector, including the reactive branch.
test.each([
  ['custom-model', 'unknown-model', true, 200_000],
  ['claude-opus-5-5', 'model-default', true, 1_000_000],
  ['claude-sonnet-5-5', 'model-default', true, 1_000_000],
  ['claude-haiku-4-5', 'auto', false, 200_000],
  ['claude-sonnet-4-6[1m]', 'auto', false, 1_000_000],
  ['custom-model[1m]', 'auto', false, 1_000_000],
] as const)('reactive compaction preserves provenance and enforcement for %s', (model, source, enforced, window) => {
  const state = getAutoCompactState(model, undefined, true)
  expect(state).toEqual({ enabled: true, source, enforced, effective_window: window - 4096, threshold: window - 4096 - 13_000 })
  expect(getAutoCompactState(model, undefined, false)).toEqual({ ...state, enforced: true })
})
