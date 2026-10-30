import { afterAll, beforeEach, expect, mock, test } from 'bun:test'

const aliasEnvKeys = ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_CUSTOM_MODEL_OPTION'] as const
const originalEnv = Object.fromEntries(aliasEnvKeys.map(key => [key, process.env[key]]))
afterAll(() => {
  for (const key of aliasEnvKeys) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
})

let provider = 'firstParty'
let subscriber = false
let premium = false
let customOpus: string | undefined
let customSonnet: string | undefined
let currentModel: string | undefined
let discovered: unknown[] | undefined
let discoveredCacheKey: string | undefined
let firstPartyCacheKey: string | null = 'anthropic:first-party:test'
let gatewayOptions: Array<{ value: string; label: string; description: string }> = []
let servedCatalog: unknown
const modelStrings = {
  opus41: 'backend/opus-4-1', opus46: 'backend/opus-4-6', sonnet46: 'backend/sonnet-4-6', haiku45: 'claude-haiku-4-5-20251001',
  opus55: 'claude-opus-5-5', fable51: 'claude-fable-5-1', sonnet55: 'claude-sonnet-5-5', opus46Canonical: 'claude-opus-4-6',
  sonnet50: 'claude-sonnet-5', opus50: 'claude-opus-5', fable50: 'claude-fable-5',
  opus48: 'claude-opus-4-8', opus47: 'claude-opus-4-7', sonnet46Canonical: 'claude-sonnet-4-6',
  mythos51: 'claude-mythos-5-1',
}
mock.module('./providers.js', () => ({ getAPIProvider: () => provider }))
mock.module('../auth.js', () => ({
  isClaudeAISubscriber: () => subscriber,
  isMaxSubscriber: () => premium,
  isTeamPremiumSubscriber: () => false,
}))
mock.module('../userType.js', () => ({ isAnt: () => false }))
mock.module('../../bootstrap/state.js', () => ({ getInitialMainLoopModel: () => null }))
mock.module('../settings/settings.js', () => ({ getSettings_DEPRECATED: () => ({}) }))
mock.module('../config.js', () => ({
  getGlobalConfig: () => ({
    additionalModelOptionsCache: discovered,
    additionalModelOptionsCacheKey: discoveredCacheKey,
  }),
}))
mock.module('./openaiModelOptions.js', () => ({
  getFirstPartyModelCacheKey: () => firstPartyCacheKey,
  getModelDiscoveryCacheKey: () =>
    provider === 'openai' ? 'openai:test' : null,
  getOpenAIModelOptions: () => [],
  getGatewayModelOptions: () => gatewayOptions,
}))
mock.module('./servedModelCatalog.js', () => ({
  getServedModelCatalog: () => servedCatalog,
}))
mock.module('./modelAllowlist.js', () => ({ isModelAllowed: () => true }))
mock.module('./modelStrings.js', () => ({ getModelStrings: () => modelStrings }))
mock.module('./check1mAccess.js', () => ({ checkOpus1mAccess: () => true, checkSonnet1mAccess: () => true }))
mock.module('../context.js', () => ({ has1mContext: (model: string) => model.includes('[1m]') }))
const names: Record<string, string> = { 'claude-opus-5-5': 'Opus 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-fable-5-1': 'Fable 5.1' }
mock.module('./model.js', () => ({
  getCanonicalName: (model: string) => model,
  getClaudeAiUserDefaultModelDescription: () => 'Default Opus 5.5',
  getDefaultSonnetModel: () => customSonnet ?? 'claude-sonnet-5-5',
  getDefaultOpusModel: () => customOpus ?? 'claude-opus-5-5',
  getDefaultFableModel: () => 'claude-fable-5-1',
  getDefaultHaikuModel: () => modelStrings.haiku45,
  getDefaultMainLoopModelSetting: () => customOpus ?? 'claude-opus-5-5',
  getMarketingNameForModel: (model: string) => names[model],
  getUserSpecifiedModelSetting: () => currentModel,
  isOpus1mMergeEnabled: () => false,
  getOpusPricingSuffix: () => '',
  renderDefaultModelSetting: (model: string) => names[model] ?? model,
}))
mock.module('../modelCost.js', () => ({
  COST_TIER_3_15: 'old-price', COST_HAIKU_35: 'haiku35', COST_HAIKU_45: 'haiku45', COST_HAIKU_55: 'haiku55',
  formatModelPricing: (cost: string) => cost,
  getModelPricingString: (model: string) => names[model] ? `pricing:${model}` : undefined,
}))
const { getModelOptions, resolveServedModelAliasForPersistence } = await import('./modelOptions.js')
beforeEach(() => {
  for (const key of aliasEnvKeys) delete process.env[key]
  provider = 'firstParty'
  subscriber = false
  premium = false
  customOpus = customSonnet = currentModel = undefined
  discovered = undefined
  discoveredCacheKey = undefined
  firstPartyCacheKey = 'anthropic:first-party:test'
  gatewayOptions = []
  servedCatalog = undefined
})

test('first-party catalog offers current aliases without gated Mythos models', () => {
  const options = getModelOptions()
  expect(options.find(option => option.value === 'opus')?.description).toContain('Opus 5.5')
  expect(options.find(option => option.value === 'sonnet')?.description).toContain('Sonnet 5.5')
  expect(options.find(option => option.value === 'sonnet')?.description).toContain('pricing:claude-sonnet-5-5')
  expect(options.find(option => option.value === null)?.description).toContain('pricing:claude-opus-5-5')
  expect(options.find(option => option.value === 'fable')?.description).toContain('Fable 5.1')
  expect(options.some(option => /mythos/i.test(`${option.value} ${option.label} ${option.description}`))).toBe(false)
  expect(options.some(option => /4\.6|old-price/.test(option.description))).toBe(false)
})

test('served catalog replaces compiled first-party rows and marks uncompiled rows', () => {
  servedCatalog = {
    surface: 'cc',
    config: {
      id: 'cc',
      models: [
        { id: 'claude-opus-5-5', name: 'Opus 5.5', section: 'main', description: 'For complex work and everyday tasks', thinking: { effort_options: [{ id: 'low' }, { id: 'medium', badge: { message: 'Recommended' } }, { id: 'max' }] } },
        { id: 'claude-fable-5-1', name: 'Fable 5.1', section: 'main' },
        { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', section: 'main' },
        { id: 'claude-haiku-5-5', name: 'Haiku 5.5', section: 'main', description: 'Fastest for quick answers' },
        { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', section: 'overflow' },
        { id: 'claude-sonnet-5', name: 'Sonnet 5', section: 'overflow' },
        { id: 'claude-opus-5', name: 'Opus 5', section: 'overflow' },
        { id: 'claude-fable-5', name: 'Fable 5', section: 'overflow' },
        { id: 'claude-opus-4-8', name: 'Opus 4.8', section: 'overflow' },
        { id: 'claude-opus-4-7', name: 'Opus 4.7', section: 'overflow' },
        { id: 'claude-opus-4-6', name: 'Opus 4.6', section: 'overflow' },
        { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', section: 'overflow' },
        { id: 'claude-mythos-5-1', name: 'Mythos 5.1', section: 'overflow' },
      ],
    },
  }

  const options = getModelOptions()
  expect(options.map(option => option.value)).toEqual([
    null,
    'claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5',
    'claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5',
    'claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6',
    'claude-sonnet-4-6', 'claude-mythos-5-1', 'claude-haiku-5-5',
  ])
  expect(options.at(-1)).toMatchObject({
    label: 'Haiku 5.5',
    description: 'Update Claude Code to use this model',
    disabled: true,
  })
  expect(options.at(-1)?.effortOptions).toBeUndefined()
  expect(options[1]).toMatchObject({ effortOptions: ['low', 'medium', 'max'], defaultEffort: 'medium' })
})

test('served catalog resolves an alias to its existing full-id row instead of appending a duplicate', () => {
  servedCatalog = {
    surface: 'cc',
    config: {
      id: 'cc',
      models: [
        { id: 'claude-opus-5-5', name: 'Opus 5.5', section: 'main' },
        { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', section: 'main' },
        { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', section: 'overflow' },
      ],
    },
  }
  currentModel = 'opus'

  const options = getModelOptions()

  expect(options.map(option => option.value)).toEqual([
    null,
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-haiku-4-5-20251001',
  ])
})

test('served catalog persists the family alias when a current family row is selected', () => {
  servedCatalog = {
    surface: 'cc',
    config: {
      id: 'cc',
      models: [
        { id: 'claude-opus-5-5', name: 'Opus 5.5', section: 'main' },
        { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', section: 'main' },
        { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', section: 'overflow' },
        { id: 'claude-fable-5-1', name: 'Fable 5.1', section: 'main' },
      ],
    },
  }

  expect(resolveServedModelAliasForPersistence('claude-opus-5-5')).toBe('opus')
  expect(resolveServedModelAliasForPersistence('claude-sonnet-5-5')).toBe('sonnet')
  expect(resolveServedModelAliasForPersistence('claude-haiku-4-5-20251001')).toBe('haiku')
  expect(resolveServedModelAliasForPersistence('claude-fable-5-1')).toBe('fable')
  expect(resolveServedModelAliasForPersistence('claude-sonnet-5')).toBe('claude-sonnet-5')

  servedCatalog = {
    surface: 'cc',
    config: {
      id: 'cc',
      models: [{ id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', section: 'main' }],
    },
  }
  expect(resolveServedModelAliasForPersistence('claude-opus-5-5')).toBe(
    'claude-opus-5-5',
  )
})

test('subscriber catalog also offers both new families without PAYG pricing', () => {
  subscriber = true
  for (premium of [false, true]) {
    const options = getModelOptions()
    expect(options.find(option => option.value === 'sonnet')?.description).toContain('Sonnet 5.5')
    expect(options.find(option => option.value === 'opus')?.description).toContain('Opus 5.5')
    expect(options.some(option => option.description.includes('pricing:'))).toBe(false)
    expect(options.find(option => option.value === 'haiku')?.description).not.toContain('haiku45')
  }
})

test('third-party catalogs retain supported old backend IDs', () => {
  for (provider of ['bedrock', 'vertex', 'foundry']) {
    const options = getModelOptions()
    expect(options.find(option => option.label === 'Opus 4.1')?.value).toBe(modelStrings.opus41)
    expect(options.some(option => option.value === modelStrings.opus46)).toBe(true)
    expect(options.some(option => option.value === modelStrings.sonnet46)).toBe(true)
    expect(options.some(option => /Opus 5|Sonnet 5/.test(option.description) && option.value !== null)).toBe(false)
  }
})

test('alias overrides and pinned models remain visible without false new-model pricing', () => {
  customOpus = 'Gateway/CustomOpus'
  customSonnet = 'Gateway/CustomSonnet'
  currentModel = 'claude-opus-4-6'
  const options = getModelOptions()
  expect(options.find(option => option.value === 'opus')?.description).toContain(customOpus)
  expect(options.find(option => option.value === 'sonnet')?.description).toContain(customSonnet)
  expect(options.find(option => option.value === null)?.description).not.toContain('pricing:')
  expect(options.some(option => option.value === currentModel)).toBe(true)
})

test('first-party Haiku override is not presented as the stock 4.5 model', () => {
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'Gateway/Small'
  const option = getModelOptions().find(option => option.value === 'haiku')
  expect(option?.label).toBe('Gateway/Small')
  expect(option?.description).not.toContain('Haiku 4.5')
})

test('Fable is a first-party family option and pinned legacy IDs remain visible', () => {
  expect(getModelOptions().find(option => option.value === 'fable')?.description).toContain('Fable 5.1')
  currentModel = 'claude-fable-5'
  expect(getModelOptions().some(option => option.value === currentModel)).toBe(true)
})

test('first-party bootstrap options extend the static catalog and preserve unknown current IDs', () => {
  discovered = [{ value: 'Bootstrap/Unknown', label: 'Unknown', description: 'From bootstrap' }]
  discoveredCacheKey = firstPartyCacheKey ?? undefined
  currentModel = 'Gateway/Current'
  expect(getModelOptions().map(option => option.value)).toEqual([
    null,
    'fable',
    'opus',
    'sonnet',
    'haiku',
    'Bootstrap/Unknown',
    'Gateway/Current',
  ])
})

test('first-party bootstrap cache is isolated by endpoint and credential identity', () => {
  discovered = [{
    value: 'claude-account-a',
    label: 'Account A',
    description: 'From first-party bootstrap',
  }]
  discoveredCacheKey = 'anthropic:first-party:account-a'
  firstPartyCacheKey = 'anthropic:first-party:account-b'

  expect(getModelOptions().some(option => option.value === 'claude-account-a')).toBe(false)
  expect(getModelOptions().some(option => option.value === 'opus')).toBe(true)

  firstPartyCacheKey = discoveredCacheKey
  expect(getModelOptions().map(option => option.value)).toEqual([
    null,
    'fable',
    'opus',
    'sonnet',
    'haiku',
    'claude-account-a',
  ])
})

test('gateway models are appended to the bootstrap catalog without duplicates', () => {
  gatewayOptions = [
    { value: 'Gateway/Model', label: 'Gateway Model', description: 'From gateway' },
    { value: 'sonnet', label: 'Duplicate', description: 'From gateway' },
  ]
  const values = getModelOptions().map(option => option.value)
  expect(values).toContain('opus')
  expect(values).toContain('Gateway/Model')
  expect(values.filter(value => value === 'sonnet')).toHaveLength(1)
  expect(getModelOptions().find(option => option.value === 'sonnet')?.label).not.toBe('Duplicate')

  discovered = [{ value: 'Bootstrap/Extra', label: 'Bootstrap Extra', description: 'From bootstrap' }]
  discoveredCacheKey = firstPartyCacheKey ?? undefined
  expect(getModelOptions().map(option => option.value)).toEqual([
    null,
    'fable',
    'opus',
    'sonnet',
    'haiku',
    'Bootstrap/Extra',
    'Gateway/Model',
  ])
})
