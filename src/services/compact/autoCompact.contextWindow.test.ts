import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const settings = await import('../../utils/settings/settings.js')
let userSettings: ReturnType<typeof settings.getSettingsForSource> = {
  autoCompactWindow: 150_000,
}
let projectSettings: ReturnType<typeof settings.getSettingsForSource> = {}
const getSettings = spyOn(settings, 'getSettingsForSource').mockImplementation(
  source =>
    source === 'userSettings'
      ? userSettings
      : source === 'projectSettings'
        ? projectSettings
        : {},
)
const api = await import('../api/claude.js')
// This test isolates window selection from provider/model output limits.
const maxOutput = spyOn(api, 'getMaxOutputTokensForModel').mockReturnValue(4096)
const config = await import('../../utils/config.js')
const globalConfig = spyOn(config, 'getGlobalConfig').mockReturnValue({ autoCompactEnabled: true } as ReturnType<typeof config.getGlobalConfig>)
const {
  getEffectiveContextWindowSize,
  getAutoCompactThreshold,
  getAutoCompactState,
  getConfiguredAutoCompactWindow,
  getLargerContextSummaryModel,
  resolveAutoCompactWindow,
} = await import('./autoCompact.js')

const previousAutoCompactWindow =
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW

afterEach(() => {
  userSettings = { autoCompactWindow: 150_000 }
  projectSettings = {}
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
  userSettings = {}
  const state = getAutoCompactState(model, true)
  expect(state).toEqual({ enabled: true, source, enforced, effective_window: window - 4096, threshold: window - 4096 - 13_000 })
  expect(getAutoCompactState(model, false)).toEqual({ ...state, enforced: true })
})

test('autocompact_state follows the per-model window the engine uses', () => {
  userSettings = {
    autoCompactWindow: 150_000,
    modelSettings: { 'custom-model': { autoCompactWindow: 120_000 } },
  }
  expect(resolveAutoCompactWindow('custom-model')).toEqual({ window: 120_000, source: 'settings' })
  expect(getAutoCompactState('custom-model', false)).toEqual({
    enabled: true,
    source: 'settings',
    enforced: true,
    effective_window: getEffectiveContextWindowSize('custom-model'),
    threshold: getAutoCompactThreshold('custom-model'),
  })
})

test('per-model autoCompactWindow overrides the top-level value within a source', () => {
  userSettings = {
    autoCompactWindow: 150_000,
    modelSettings: { 'custom-model': { autoCompactWindow: 300_000 } },
  }
  expect(getConfiguredAutoCompactWindow('custom-model')).toBe(300_000)
  expect(getConfiguredAutoCompactWindow('custom-model[1m]')).toBe(300_000)
  expect(getConfiguredAutoCompactWindow('other-model')).toBe(150_000)

  // Dated and [1m] spellings in settings match the canonical model key.
  userSettings = {
    modelSettings: { 'claude-sonnet-4-6-20250101': { autoCompactWindow: 400_000 } },
  }
  expect(getConfiguredAutoCompactWindow('claude-sonnet-4-6[1m]')).toBe(400_000)

  // "auto" per model clears a top-level value from the same file.
  userSettings = {
    autoCompactWindow: 150_000,
    modelSettings: { 'custom-model': { autoCompactWindow: 'auto' } },
  }
  expect(getConfiguredAutoCompactWindow('custom-model')).toBeUndefined()
})

test('a higher-priority top-level value replaces lower per-model values', () => {
  userSettings = {
    modelSettings: { 'custom-model': { autoCompactWindow: 300_000 } },
  }
  projectSettings = { autoCompactWindow: 120_000 }
  expect(getConfiguredAutoCompactWindow('custom-model')).toBe(120_000)

  projectSettings = {
    modelSettings: { 'other-model': { autoCompactWindow: 500_000 } },
  }
  expect(getConfiguredAutoCompactWindow('custom-model')).toBe(300_000)
})

test('an agent autoCompactWindow only lowers the window and yields to the environment', () => {
  userSettings = { autoCompactWindow: 150_000 }
  expect(resolveAutoCompactWindow('custom-model', 120_000)).toEqual({ window: 120_000, source: 'settings' })
  expect(resolveAutoCompactWindow('custom-model', 180_000)).toEqual({ window: 150_000, source: 'settings' })
  expect(getEffectiveContextWindowSize('custom-model', 120_000)).toBe(115_904)
  expect(getAutoCompactThreshold('custom-model', 120_000)).toBe(102_904)

  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '180000'
  expect(resolveAutoCompactWindow('custom-model', 120_000)).toEqual({ window: 180_000, source: 'env' })
})

test('a conversation too long for a smaller new model is summarized by the previous model', () => {
  userSettings = {}
  const assistant = (requestedModel: string, inputTokens: number) => ({
    type: 'assistant' as const,
    uuid: 'a',
    timestamp: '',
    requestedModel,
    message: {
      id: 'm',
      model: requestedModel,
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  })
  // claude-haiku-4-5 has a 200K window; claude-sonnet-4-6[1m] has 1M.
  const long = [assistant('claude-sonnet-4-6[1m]', 400_000)] as never
  expect(getLargerContextSummaryModel(long, 'claude-haiku-4-5')).toBe('claude-sonnet-4-6[1m]')
  // Still fits the new model: nothing to do.
  const short = [assistant('claude-sonnet-4-6[1m]', 50_000)] as never
  expect(getLargerContextSummaryModel(short, 'claude-haiku-4-5')).toBeUndefined()
  // The previous model is not larger.
  const sameSize = [assistant('claude-haiku-4-5', 400_000)] as never
  expect(getLargerContextSummaryModel(sameSize, 'claude-sonnet-4-6')).toBeUndefined()
  // A disallowed previous model is never used.
  const merged = spyOn(settings, 'getSettings_DEPRECATED').mockReturnValue({ availableModels: ['haiku'] })
  try {
    expect(getLargerContextSummaryModel(long, 'claude-haiku-4-5')).toBeUndefined()
  } finally {
    merged.mockRestore()
  }
})

// Like 2.1.311, --autocompact sets the window for the session over settings.
test('--autocompact wins over configured settings, and auto drops them', async () => {
  const { setCliAutoCompactWindow } = await import('../../bootstrap/state.js')
  try {
    setCliAutoCompactWindow(300_000)
    expect(getConfiguredAutoCompactWindow('custom-model')).toBe(300_000)
    setCliAutoCompactWindow('auto')
    expect(getConfiguredAutoCompactWindow('custom-model')).toBeUndefined()
  } finally {
    setCliAutoCompactWindow(undefined)
  }
  expect(getConfiguredAutoCompactWindow('custom-model')).toBe(150_000)
})
