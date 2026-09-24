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
const bootstrap = await import('../bootstrap/state.js')
const interactive = spyOn(bootstrap, 'getIsInteractive').mockReturnValue(true)
const originalEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
const {
  getContextWindowForModel,
  getModelMaxOutputTokens,
  modelSupports1M,
  resolveContextWindow,
} = await import('./context.js')

afterAll(() => {
  mock.restore()
  if (originalEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT
  else process.env.CLAUDE_CODE_ENTRYPOINT = originalEntrypoint
})

afterEach(() => {
  delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
  delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  if (originalEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT
  else process.env.CLAUDE_CODE_ENTRYPOINT = originalEntrypoint
  capability.mockReturnValue(undefined)
  ant.mockReturnValue(false)
  globalConfig.mockReturnValue({
    autoCompactEnabled: true,
  } as unknown as ReturnType<typeof config.getGlobalConfig>)
  feature.mockImplementation((_name, fallback) => fallback)
  subscription.mockReturnValue(null)
  interactive.mockReturnValue(true)
})

test.each(['claude-opus-5', 'claude-sonnet-5'])(
  '%s has native 1M input context and a conservative 32K output default',
  (model) => {
    expect(modelSupports1M(model)).toBe(true)
    expect(getContextWindowForModel(model)).toBe(1_000_000)
    expect(getModelMaxOutputTokens(model)).toEqual({
      default: 32_000,
      upperLimit: 128_000,
    })
    process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1'
    expect(modelSupports1M(model)).toBe(false)
    expect(getContextWindowForModel(model)).toBe(200_000)
    expect(getContextWindowForModel(`${model}[1m]`)).toBe(200_000)
  },
)

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

test('context window resolver reports real compaction sources', () => {
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '123.456k'

  expect(resolveContextWindow('custom-model', 150_000)).toEqual({
    window: 123_456,
    source: 'env',
  })

  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '123.456k trailing'
  expect(resolveContextWindow('custom-model', 150_000)).toEqual({
    window: 150_000,
    source: 'settings',
  })

  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '99999'
  expect(resolveContextWindow('custom-model', 150_000)).toEqual({
    window: 150_000,
    source: 'settings',
  })

  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '1000001'
  expect(resolveContextWindow('custom-model')).toEqual({
    window: 200_000,
    source: 'auto',
  })

  delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  expect(resolveContextWindow('custom-model', 150_000)).toEqual({
    window: 150_000,
    source: 'settings',
  })
  expect(resolveContextWindow('custom-model')).toEqual({
    window: 200_000,
    source: 'auto',
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

test('experiment compaction window applies only to interactive Opus 4.8', () => {
  feature.mockImplementation((name, fallback) =>
    name === 'tengu_amber_redwood2' ? ('480k' as typeof fallback) : fallback,
  )

  expect(resolveContextWindow('claude-opus-4-8')).toEqual({
    window: 200_000,
    source: 'experiment',
  })
  expect(resolveContextWindow('custom-model')).toEqual({
    window: 200_000,
    source: 'auto',
  })

  interactive.mockReturnValue(false)
  expect(resolveContextWindow('claude-opus-4-8')).toEqual({
    window: 200_000,
    source: 'auto',
  })
})

test('bootstrap model defaults apply after an explicit client-data replacement', () => {
  globalConfig.mockReturnValue({
    autoCompactEnabled: true,
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
