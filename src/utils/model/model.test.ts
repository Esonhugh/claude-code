import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { ALL_MODEL_CONFIGS } from './configs.js'
import { getAPIProvider } from './providers.js'
import type { ModelSetting } from './model.js'

let modelOverride: ModelSetting | undefined
let settings: { model?: string; availableModels?: string[] } = {}
let modelOverrides: Record<string, string> = {}

mock.module('../../bootstrap/state.js', () => ({
  getMainLoopModelOverride: () => modelOverride,
}))
mock.module('../settings/settings.js', () => ({
  getSettings_DEPRECATED: () => settings,
}))
mock.module('../auth.js', () => ({
  getSubscriptionType: () => null,
  isClaudeAISubscriber: () => false,
  isMaxSubscriber: () => false,
  isProSubscriber: () => false,
  isTeamPremiumSubscriber: () => false,
}))
mock.module('../userType.js', () => ({ isAnt: () => false }))
mock.module('../../constants/figures.js', () => ({ LIGHTNING_BOLT: 'fast' }))
mock.module('../modelCost.js', () => ({
  formatModelPricing: () => '$5/$25 per Mtok',
  getOpus46CostTier: () => ({}),
}))
mock.module('../context.js', () => ({
  has1mContext: (model: string) => /\[1m\]/i.test(model),
  is1mContextDisabled: () => false,
  modelSupports1M: () => true,
}))
mock.module('./modelStrings.js', () => ({
  getModelStrings: () => {
    const provider = getAPIProvider()
    return Object.fromEntries(Object.entries(ALL_MODEL_CONFIGS).map(([key, config]) => [
      key,
      modelOverrides[config.firstParty] ?? config[provider === 'openai' ? 'firstParty' : provider],
    ]))
  },
  resolveOverriddenModel: (model: string) =>
    Object.entries(modelOverrides).find(([, value]) => value === model)?.[0] ?? model,
}))

const {
  getMainLoopModel,
  getDefaultMainLoopModel,
  getDefaultOpusModel,
  getDefaultSonnetModel,
  getDefaultHaikuModel,
  getSmallFastModel,
  getUserSpecifiedModelSetting,
  parseUserSpecifiedModel,
  getCanonicalName,
  getPublicModelDisplayName,
  getMarketingNameForModel,
  renderDefaultModelSetting,
} = await import('./model.js')

const envKeys = [
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
] as const
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))

beforeEach(() => {
  modelOverride = undefined
  settings = {}
  modelOverrides = {}
  for (const key of envKeys) delete process.env[key]
})
afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('provider defaults and explicit model selection', () => {
  test('first-party defaults to Opus 5 without upgrading explicit IDs', () => {
    expect(getDefaultMainLoopModel()).toBe('claude-opus-5')
    expect(getDefaultSonnetModel()).toBe('claude-sonnet-5')
    expect(getDefaultHaikuModel()).toBe('claude-haiku-4-5-20251001')
    for (const model of ['claude-opus-4-20250514', 'claude-opus-4-1', 'Gateway/Custom-ID']) {
      expect(parseUserSpecifiedModel(model)).toBe(model)
    }
  })

  test('OpenAI defaults and role aliases resolve before transport', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    expect(getDefaultMainLoopModel()).toBe('gpt-5.6-sol')
    expect(parseUserSpecifiedModel('opus')).toBe('gpt-5.6-sol')
    expect(parseUserSpecifiedModel('best')).toBe('gpt-5.6-sol')
    expect(parseUserSpecifiedModel('sonnet')).toBe('gpt-5.6-terra')
    expect(parseUserSpecifiedModel('haiku')).toBe('gpt-5.6-luna')
    expect(getSmallFastModel()).toBe('gpt-5.6-luna')
    expect(parseUserSpecifiedModel('claude-opus-4-6')).toBe('claude-opus-4-6')
  })

  test('alias environment mappings take priority on either provider', () => {
    for (const openAI of ['0', '1']) {
      process.env.CLAUDE_CODE_USE_OPENAI = openAI
      process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'Gateway/Opus'
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'Gateway/Sonnet'
      process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'Gateway/Haiku'
      expect(getDefaultOpusModel()).toBe('Gateway/Opus')
      expect(getDefaultSonnetModel()).toBe('Gateway/Sonnet')
      expect(getDefaultHaikuModel()).toBe('Gateway/Haiku')
    }
  })

  test('session override beats env then settings, and null stops fallback', () => {
    settings.model = 'saved-model'
    expect(getMainLoopModel()).toBe('saved-model')
    process.env.ANTHROPIC_MODEL = 'environment-model'
    expect(getMainLoopModel()).toBe('environment-model')
    modelOverride = 'session-model'
    expect(getMainLoopModel()).toBe('session-model')
    modelOverride = null
    expect(getUserSpecifiedModelSetting()).toBeNull()
    expect(getMainLoopModel()).toBe('claude-opus-5')
  })

  test('explicit GPT model on Anthropic protocol stays explicit', () => {
    settings.model = 'gpt-5.6-sol'
    expect(getUserSpecifiedModelSetting()).toBe('gpt-5.6-sol')
    expect(getMainLoopModel()).toBe('gpt-5.6-sol')
  })

  test('explicit model equal to fallback is distinguishable from unset', () => {
    expect(getUserSpecifiedModelSetting()).toBeUndefined()
    modelOverride = 'claude-opus-5'
    expect(getUserSpecifiedModelSetting()).toBe('claude-opus-5')
  })

  test('existing allowlist still rejects a disallowed explicit model', () => {
    settings = { model: 'blocked', availableModels: ['allowed'] }
    expect(getUserSpecifiedModelSetting()).toBeUndefined()
  })

  test('third-party Opus defaults keep existing provider IDs', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    expect(getDefaultMainLoopModel()).toBe(ALL_MODEL_CONFIGS.opus46.bedrock)
    expect(getDefaultSonnetModel()).toBe(ALL_MODEL_CONFIGS.sonnet45.bedrock)
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    process.env.CLAUDE_CODE_USE_VERTEX = '1'
    expect(getDefaultMainLoopModel()).toBe(ALL_MODEL_CONFIGS.opus46.vertex)
    delete process.env.CLAUDE_CODE_USE_VERTEX
    process.env.CLAUDE_CODE_USE_FOUNDRY = '1'
    expect(getDefaultMainLoopModel()).toBe(ALL_MODEL_CONFIGS.opus46.foundry)
  })

  test('canonical model overrides continue to apply to new aliases', () => {
    modelOverrides = { 'claude-opus-5': 'Gateway/Opus-Deployment' }
    expect(parseUserSpecifiedModel('opus')).toBe('Gateway/Opus-Deployment')
    expect(getCanonicalName('Gateway/Opus-Deployment')).toBe('claude-opus-5')
    expect(parseUserSpecifiedModel('Gateway/Other-Deployment')).toBe('Gateway/Other-Deployment')
  })

  test('canonical names, labels and plan descriptions match new defaults', () => {
    expect(getCanonicalName('claude-opus-5')).toBe('claude-opus-5')
    expect(getCanonicalName('anthropic.claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(getPublicModelDisplayName('claude-opus-5')).toBe('Opus 5')
    expect(getMarketingNameForModel('claude-sonnet-5')).toBe('Sonnet 5')
    expect(renderDefaultModelSetting('opusplan')).toBe('Opus 5 in plan mode, else Sonnet 5')
  })
})
