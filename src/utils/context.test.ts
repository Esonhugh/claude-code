import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test'
;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const capabilities = await import('./model/modelCapabilities.js')
const capability = spyOn(capabilities, 'getModelCapability').mockReturnValue(
  undefined,
)
const userType = await import('./userType.js')
const ant = spyOn(userType, 'isAnt').mockReturnValue(false)
const config = await import('./config.js')
const globalConfig = spyOn(config, 'getGlobalConfig').mockReturnValue({
  autoCompactEnabled: true,
} as unknown as ReturnType<typeof config.getGlobalConfig>)
const growthbook = await import('../services/analytics/growthbook.js')
const feature = spyOn(
  growthbook,
  'getFeatureValue_CACHED_MAY_BE_STALE',
).mockImplementation((_name, fallback) => fallback)
const auth = await import('./auth.js')
const subscription = spyOn(auth, 'getSubscriptionType').mockReturnValue(null)
const cacheIdentity = await import('./model/firstPartyModelCacheKey.js')
const firstPartyCacheKey = spyOn(
  cacheIdentity,
  'getFirstPartyModelCacheKey',
).mockReturnValue(null)
const bootstrap = await import('../bootstrap/state.js')
const interactive = spyOn(bootstrap, 'getIsInteractive').mockReturnValue(true)
const originalEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
const originalAnthropicBaseURL = process.env.ANTHROPIC_BASE_URL
const {
  getContextWindowForModel,
  getModelMaxOutputTokens,
  getSonnet1mExpTreatmentEnabled,
  modelSupports1M,
  resolveContextWindow,
} = await import('./context.js')

afterAll(() => {
  mock.restore()
  if (originalEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT
  else process.env.CLAUDE_CODE_ENTRYPOINT = originalEntrypoint
  if (originalAnthropicBaseURL === undefined) delete process.env.ANTHROPIC_BASE_URL
  else process.env.ANTHROPIC_BASE_URL = originalAnthropicBaseURL
})

afterEach(() => {
  delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
  delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  delete process.env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT
  delete process.env.DISABLE_AUTO_COMPACT
  delete process.env.DISABLE_COMPACT
  if (originalEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT
  else process.env.CLAUDE_CODE_ENTRYPOINT = originalEntrypoint
  if (originalAnthropicBaseURL === undefined) delete process.env.ANTHROPIC_BASE_URL
  else process.env.ANTHROPIC_BASE_URL = originalAnthropicBaseURL
  capability.mockReturnValue(undefined)
  ant.mockReturnValue(false)
  globalConfig.mockReturnValue({
    autoCompactEnabled: true,
  } as unknown as ReturnType<typeof config.getGlobalConfig>)
  feature.mockImplementation((_name, fallback) => fallback)
  subscription.mockReturnValue(null)
  firstPartyCacheKey.mockReturnValue('anthropic:test')
  interactive.mockReturnValue(true)
})

test.each([
  ['claude-fable-5-1', 64_000],
  ['claude-mythos-5-1', 64_000],
  ['claude-mythos-5', 64_000],
  ['claude-mythos-preview', 64_000],
  ['claude-opus-5-5', 128_000],
  ['claude-sonnet-5-5', 128_000],
  ['claude-fable-5', 64_000],
  ['claude-opus-5', 64_000],
  ['claude-sonnet-5', 64_000],
  ['claude-opus-4-8', 64_000],
  ['claude-opus-4-7', 64_000],
] as const)(
  '%s has native 1M input context and the 2.1.311 catalog output default',
  (model, defaultTokens) => {
    expect(modelSupports1M(model)).toBe(true)
    expect(getContextWindowForModel(model)).toBe(1_000_000)
    expect(getModelMaxOutputTokens(model)).toEqual({
      default: defaultTokens,
      upperLimit: 128_000,
    })
    process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1'
    expect(modelSupports1M(model)).toBe(false)
    expect(getContextWindowForModel(model)).toBe(200_000)
    expect(getContextWindowForModel(`${model}[1m]`)).toBe(200_000)
  },
)

test('claude-haiku-5-5 defaults to 128K output like 2.1.311', () => {
  expect(getModelMaxOutputTokens('claude-haiku-5-5')).toEqual({
    default: 128_000,
    upperLimit: 128_000,
  })
})

test.each(['gpt-5.6-sol', 'gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.6-luna'])(
  '%s budgets against the 922K input limit, not its 1,050K total window',
  (model) => {
    expect(getContextWindowForModel(model)).toBe(922_000)
    expect(getContextWindowForModel(`${model}[1m]`)).toBe(922_000)
    expect(getModelMaxOutputTokens(model)).toEqual({
      default: 32_000,
      upperLimit: 128_000,
    })
    process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1'
    expect(getContextWindowForModel(model)).toBe(200_000)
  },
)

test('context and discovered capability overrides retain precedence', () => {
  capability.mockReturnValue({
    id: 'claude-opus-5',
    max_input_tokens: 300_000,
    max_tokens: 16_000,
  })
  expect(getContextWindowForModel('claude-opus-5')).toBe(300_000)
  expect(getModelMaxOutputTokens('claude-opus-5')).toEqual({
    default: 16_000,
    upperLimit: 16_000,
  })
  ant.mockReturnValue(true)
  process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '123456'
  expect(getContextWindowForModel('claude-opus-5[1m]')).toBe(123456)
})

test('unknown and legacy models keep their existing limits', () => {
  expect(getContextWindowForModel('custom-model')).toBe(200_000)
  expect(getModelMaxOutputTokens('custom-model')).toEqual({
    default: 32_000,
    upperLimit: 64_000,
  })
  expect(getModelMaxOutputTokens('claude-opus-4-6')).toEqual({
    default: 64_000,
    upperLimit: 128_000,
  })
})

// Fixed 2.1.292 wE/fDe/ld: environment integers and numeric prefixes differ
// from command/settings suffix parsing; grouped/scientific forms use ld.
test.each([
  ["200k", 100000, "env"],
  ["200000", 200000, "env"],
  ["123.456k", 100000, "env"],
  ["123.456k trailing", 100000, "env"],
  ["99999", 100000, "env"],
  ["1000001", 1000000, "env"],
  ["0", 150000, "settings"],
  ["-2", 150000, "settings"],
  ["auto", 150000, "settings"],
  ["garbage", 150000, "settings"],
  ["0x30", 150000, "settings"],
  ["200_000", 200000, "env"],
  ["200,000", 200000, "env"],
  ["200 000", 200000, "env"],
  ["200\u00a0000", 200000, "env"],
  ["200\u202f000", 200000, "env"],
  ["2e5", 200000, "env"],
  ["2.5e5", 250000, "env"],
  ["2e-1", 150000, "settings"],
  ["1e999", 150000, "settings"],
  ["9999999999999999999999999999999999999999", 1000000, "env"],
  ["00300000", 300000, "env"],
  ["+200000", 200000, "env"],
  ["250000garbage", 250000, "env"],
  ["150.9", 100000, "env"],
  ["1.5m", 100000, "env"],
  ["200,00", 100000, "env"],
  ["1,000_000", 100000, "env"],
] as const)('environment window %s matches official integer parsing', (value, window, source) => {
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = value
  expect(resolveContextWindow('claude-sonnet-4-6[1m]', 150_000)).toEqual({ window, source })
})

test('context window resolver reports real compaction sources', () => {
  delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  expect(resolveContextWindow('custom-model', 150_000)).toEqual({
    window: 150_000,
    source: 'settings',
  })
  expect(resolveContextWindow('custom-model')).toEqual({
    window: 200_000,
    source: 'unknown-model',
  })
  expect(resolveContextWindow('claude-sonnet-4-6')).toEqual({
    window: 200_000,
    source: 'model-default',
  })
  expect(resolveContextWindow('claude-sonnet-5')).toEqual({
    window: 967_000,
    source: 'model-default',
  })
})

test('client data compaction windows use model, surface, and subscription selectors', () => {
  process.env.CLAUDE_CODE_ENTRYPOINT = 'local-agent'
  subscription.mockReturnValue('team')
  globalConfig.mockReturnValue({
    autoCompactEnabled: true,
    bootstrapCacheKey: 'anthropic:test',
    additionalModelOptionsCacheKey: 'anthropic:test',
    clientDataCache: {
      rowan_thicket: {
        'claude-sonnet-5': {
          default: 640_000,
          surfaces: {
            'local-agent': { default: 610_000, team: 590_000 },
          },
        },
      },
    },
  } as unknown as ReturnType<typeof config.getGlobalConfig>)

  expect(resolveContextWindow('claude-sonnet-5')).toEqual({
    window: 590_000,
    source: 'clientdata',
  })
})

test('client data surface selection falls back to the model default', () => {
  process.env.CLAUDE_CODE_ENTRYPOINT = 'local-agent'
  subscription.mockReturnValue('team')
  globalConfig.mockReturnValue({
    autoCompactEnabled: true,
    bootstrapCacheKey: 'anthropic:test',
    additionalModelOptionsCacheKey: 'anthropic:test',
    clientDataCache: {
      rowan_thicket: {
        'claude-sonnet-5': {
          default: 640_000,
          surfaces: {
            'local-agent': { enterprise: 500_000 },
          },
        },
      },
    },
  } as unknown as ReturnType<typeof config.getGlobalConfig>)

  expect(resolveContextWindow('claude-sonnet-5')).toEqual({
    window: 640_000,
    source: 'clientdata',
  })
})

test('bootstrap client data is ignored when its identity is not current', () => {
  globalConfig.mockReturnValue({
    autoCompactEnabled: true,
    bootstrapCacheKey: 'anthropic:account-a',
    additionalModelOptionsCacheKey: 'openai:account-b',
    clientDataCache: {
      rowan_thicket: { 'claude-sonnet-5': 400_000 },
      coral_reef_sonnet: 'true',
    },
    autoCompactWindowsCache: { 'claude-sonnet-5': 300_000 },
  } as unknown as ReturnType<typeof config.getGlobalConfig>)

  expect(resolveContextWindow('claude-sonnet-5')).toEqual({
    window: 967_000,
    source: 'model-default',
  })
  expect(getSonnet1mExpTreatmentEnabled('claude-sonnet-4-6')).toBe(false)
})

test('bootstrap client data is ignored when the current account changes', () => {
  firstPartyCacheKey.mockReturnValue('anthropic:account-b')
  globalConfig.mockReturnValue({
    autoCompactEnabled: true,
    bootstrapCacheKey: 'anthropic:account-a',
    additionalModelOptionsCacheKey: 'anthropic:account-a',
    clientDataCache: {
      rowan_thicket: { 'claude-sonnet-5': 400_000 },
      coral_reef_sonnet: 'true',
    },
    autoCompactWindowsCache: { 'claude-sonnet-5': 300_000 },
  } as unknown as ReturnType<typeof config.getGlobalConfig>)

  expect(resolveContextWindow('claude-sonnet-5')).toEqual({
    window: 967_000,
    source: 'model-default',
  })
  expect(getSonnet1mExpTreatmentEnabled('claude-sonnet-4-6')).toBe(false)
})

test('bootstrap client data is ignored after switching to a gateway', () => {
  process.env.ANTHROPIC_BASE_URL = 'https://gateway.example'
  firstPartyCacheKey.mockReturnValue(null)
  globalConfig.mockReturnValue({
    autoCompactEnabled: true,
    bootstrapCacheKey: 'anthropic:https://api.anthropic.com/v1:oauth:account-a',
    additionalModelOptionsCacheKey:
      'anthropic:https://api.anthropic.com/v1:oauth:account-a',
    clientDataCache: {
      rowan_thicket: { 'claude-sonnet-5': 400_000 },
      coral_reef_sonnet: 'true',
    },
    autoCompactWindowsCache: { 'claude-sonnet-5': 300_000 },
  } as unknown as ReturnType<typeof config.getGlobalConfig>)

  expect(resolveContextWindow('claude-sonnet-5')).toEqual({
    window: 967_000,
    source: 'model-default',
  })
  expect(getSonnet1mExpTreatmentEnabled('claude-sonnet-4-6')).toBe(false)
})

test('experiment compaction window applies only to interactive Opus 4.8', () => {
  feature.mockImplementation((name, fallback) =>
    name === 'tengu_amber_redwood2' ? ('480k' as typeof fallback) : fallback,
  )

  expect(resolveContextWindow('claude-opus-4-8')).toEqual({
    window: 480_000,
    source: 'experiment',
  })
  expect(resolveContextWindow('custom-model')).toEqual({
    window: 200_000,
    source: 'unknown-model',
  })

  interactive.mockReturnValue(false)
  expect(resolveContextWindow('claude-opus-4-8')).toEqual({
    window: 1_000_000,
    source: 'model-default',
  })
})

test('bootstrap model defaults apply after an explicit client-data replacement', () => {
  globalConfig.mockReturnValue({
    autoCompactEnabled: true,
    bootstrapCacheKey: 'anthropic:test',
    additionalModelOptionsCacheKey: 'anthropic:test',
    clientDataCache: {
      rowan_thicket: { 'claude-sonnet-5': 99_999 },
    },
    autoCompactWindowsCache: {
      'claude-sonnet-5': 300_000,
    },
  } as unknown as ReturnType<typeof config.getGlobalConfig>)

  expect(resolveContextWindow('claude-sonnet-5')).toEqual({
    window: 1_000_000,
    source: 'auto',
  })
})

test('bootstrap model defaults retain official surface-aware fallback values', () => {
  process.env.CLAUDE_CODE_ENTRYPOINT = 'local-agent'
  globalConfig.mockReturnValue({
    autoCompactEnabled: true,
    bootstrapCacheKey: 'anthropic:test',
    additionalModelOptionsCacheKey: 'anthropic:test',
    autoCompactWindowsCache: {
      'claude-sonnet-5': {
        default: 967_000,
        surfaces: { 'local-agent': { default: 500_000 } },
      },
    },
  } as unknown as ReturnType<typeof config.getGlobalConfig>)

  expect(resolveContextWindow('claude-sonnet-5')).toEqual({
    window: 500_000,
    source: 'model-default',
  })
})

// Official 2.1.292 real remote CLI, isolated API-key config and no API traffic.
test.each([
  ['claude-sonnet-5-5', 1_000_000, 'model-default'],
  ['claude-opus-5-5', 1_000_000, 'model-default'],
  ['claude-opus-4-8', 1_000_000, 'model-default'],
  ['claude-haiku-4-5', 200_000, 'auto'],
  ['claude-sonnet-4-6[1m]', 1_000_000, 'auto'],
  ['custom-model[1m]', 1_000_000, 'auto'],
  ['custom-model', 200_000, 'unknown-model'],
] as const)('default window provenance for %s', (model, window, source) => {
  expect(resolveContextWindow(model)).toEqual({ window, source })
})

test('unknown-model protection can be disabled without changing the window', () => {
  process.env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = '1'
  expect(resolveContextWindow('custom-model')).toEqual({ window: 200_000, source: 'auto' })
  process.env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = '0'
  expect(resolveContextWindow('custom-model')).toEqual({ window: 200_000, source: 'unknown-model' })
})

test.each(['DISABLE_AUTO_COMPACT', 'DISABLE_COMPACT', 'global'])(
  'disabled auto compaction (%s) does not enforce implicit defaults', mode => {
    if (mode === 'global') globalConfig.mockReturnValue({ autoCompactEnabled: false } as ReturnType<typeof config.getGlobalConfig>)
    else process.env[mode] = '1'
    expect(resolveContextWindow('custom-model')).toEqual({ window: 200_000, source: 'auto' })
    expect(resolveContextWindow('claude-opus-5-5')).toEqual({ window: 1_000_000, source: 'auto' })
    expect(resolveContextWindow('custom-model', 150_000)).toEqual({ window: 150_000, source: 'settings' })
  },
)

test('disabling native 1M context still reports the enforced model default', () => {
  process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1'
  expect(resolveContextWindow('claude-opus-5-5')).toEqual({ window: 200_000, source: 'model-default' })
})

test('declared capabilities and unresolved inference profiles do not count as unknown models', () => {
  capability.mockReturnValue({ id: 'custom-model', max_input_tokens: 300_000 })
  expect(resolveContextWindow('custom-model')).toEqual({ window: 300_000, source: 'auto' })
  capability.mockReturnValue(undefined)
  expect(resolveContextWindow('arn:aws:bedrock:us-east-1:123:application-inference-profile/owned')).toEqual({ window: 200_000, source: 'auto' })
})
