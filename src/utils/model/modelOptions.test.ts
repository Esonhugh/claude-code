import { afterAll, beforeEach, expect, mock, test } from 'bun:test'

const aliasEnvKeys = ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_CUSTOM_MODEL_OPTION'] as const
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
const modelStrings = {
  opus41: 'backend/opus-4-1', opus46: 'backend/opus-4-6', sonnet46: 'backend/sonnet-4-6', haiku45: 'backend/haiku-4-5',
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
mock.module('../config.js', () => ({ getGlobalConfig: () => ({ additionalModelOptionsCache: discovered }) }))
mock.module('./openaiModelOptions.js', () => ({
  isModelDiscoveryEnabled: () => false, getModelDiscoveryCacheKey: () => null,
  getOpenAIModelOptions: () => [],
}))
mock.module('./modelAllowlist.js', () => ({ isModelAllowed: () => true }))
mock.module('./modelStrings.js', () => ({ getModelStrings: () => modelStrings }))
mock.module('./check1mAccess.js', () => ({ checkOpus1mAccess: () => true, checkSonnet1mAccess: () => true }))
mock.module('../context.js', () => ({ has1mContext: (model: string) => model.includes('[1m]') }))
const names: Record<string, string> = { 'claude-opus-5': 'Opus 5', 'claude-sonnet-5': 'Sonnet 5' }
mock.module('./model.js', () => ({
  getCanonicalName: (model: string) => model,
  getClaudeAiUserDefaultModelDescription: () => 'Default Opus 5',
  getDefaultSonnetModel: () => customSonnet ?? 'claude-sonnet-5',
  getDefaultOpusModel: () => customOpus ?? 'claude-opus-5',
  getDefaultHaikuModel: () => modelStrings.haiku45,
  getDefaultMainLoopModelSetting: () => customOpus ?? 'claude-opus-5',
  getMarketingNameForModel: (model: string) => names[model],
  getUserSpecifiedModelSetting: () => currentModel,
  isOpus1mMergeEnabled: () => false,
  getOpus46PricingSuffix: () => '',
  renderDefaultModelSetting: (model: string) => names[model] ?? model,
}))
mock.module('../modelCost.js', () => ({
  COST_TIER_3_15: 'old-price', COST_HAIKU_35: 'haiku35', COST_HAIKU_45: 'haiku45',
  formatModelPricing: (cost: string) => cost,
  getModelPricingString: (model: string) => names[model] ? `pricing:${model}` : undefined,
}))
const { getModelOptions } = await import('./modelOptions.js')
beforeEach(() => {
  for (const key of aliasEnvKeys) delete process.env[key]
  provider = 'firstParty'
  subscriber = false
  premium = false
  customOpus = customSonnet = currentModel = undefined
  discovered = undefined
})

test('first-party catalog offers Opus 5 and Sonnet 5 with model-derived pricing, without Fable', () => {
  const options = getModelOptions()
  expect(options.find(option => option.value === 'opus')?.description).toContain('Opus 5')
  expect(options.find(option => option.value === 'sonnet')?.description).toContain('Sonnet 5')
  expect(options.find(option => option.value === 'sonnet')?.description).toContain('pricing:claude-sonnet-5')
  expect(options.find(option => option.value === null)?.description).toContain('pricing:claude-opus-5')
  expect(options.some(option => /Fable|4\.6|old-price/.test(option.description))).toBe(false)
})

test('subscriber catalog also offers both new families without PAYG pricing', () => {
  subscriber = true
  for (premium of [false, true]) {
    const options = getModelOptions()
    expect(options.find(option => option.value === 'sonnet')?.description).toContain('Sonnet 5')
    expect(options.find(option => option.value === 'opus')?.description).toContain('Opus 5')
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

test('Fable remains available only when explicitly selected or discovered', () => {
  expect(getModelOptions().some(option => option.value === 'claude-fable-5-1')).toBe(false)
  currentModel = 'claude-fable-5-1'
  expect(getModelOptions().some(option => option.value === currentModel)).toBe(true)
})

test('discovery still replaces the static catalog and preserves unknown current IDs', () => {
  discovered = [{ value: 'Gateway/Unknown', label: 'Unknown', description: 'From gateway' }]
  currentModel = 'Gateway/Current'
  expect(getModelOptions().map(option => option.value)).toEqual(['Gateway/Unknown', 'Gateway/Current'])
})
