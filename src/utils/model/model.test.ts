import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { ALL_MODEL_CONFIGS } from './configs.js'
import { getAPIProvider } from './providers.js'
import type { ModelSetting } from './model.js'

let modelOverride: ModelSetting | undefined
let settings: { model?: string; availableModels?: string[] } = {}
let modelOverrides: Record<string, string> = {}
let servedDefault: { model: string; orgConfigured: boolean } | undefined

mock.module('./servedModelCatalog.js', () => ({
  getServedDefaultModel: () => servedDefault,
}))
mock.module('./openaiModelOptions.js', () => ({
  getOpenAIServedDefaultModel: () => undefined,
}))

mock.module('../../bootstrap/state.js', () => ({
  getMainLoopModelOverride: () => modelOverride,
}))
mock.module('../settings/settings.js', () => ({
  getSettings_DEPRECATED: () => settings,
}))
let apiKey: { key: string | null; source: string } = { key: null, source: 'none' }
mock.module('../auth.js', () => ({
  getAnthropicApiKeyWithSource: () => apiKey,
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
  getOpusCostTier: () => ({}),
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
  getDefaultFableModel,
  getDefaultHaikuModel,
  getSmallFastModel,
  getUserSpecifiedModelSetting,
  parseUserSpecifiedModel,
  getCanonicalName,
  getPublicModelDisplayName,
  getMarketingNameForModel,
  renderDefaultModelSetting,
  getClaudeAiUserDefaultModelDescription,
  resolveFallbackModels,
} = await import('./model.js')

const envKeys = [
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
] as const
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))

beforeEach(() => {
  modelOverride = undefined
  settings = {}
  modelOverrides = {}
  servedDefault = undefined
  apiKey = { key: null, source: 'none' }
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
  test('first-party defaults to the current Opus and Sonnet releases without upgrading explicit IDs', () => {
    expect(getDefaultMainLoopModel()).toBe('claude-opus-5-5')
    expect(getDefaultSonnetModel()).toBe('claude-sonnet-5-5')
    expect(getDefaultFableModel()).toBe('claude-fable-5-1')
    expect(parseUserSpecifiedModel('fable')).toBe('claude-fable-5-1')
    expect(parseUserSpecifiedModel('best')).toBe('claude-fable-5-1')
    expect(getDefaultHaikuModel()).toBe('claude-haiku-5-5')
    expect(parseUserSpecifiedModel('haiku')).toBe('claude-haiku-5-5')
    for (const model of ['claude-opus-4-20250514', 'claude-opus-4-1', 'Gateway/Custom-ID']) {
      expect(parseUserSpecifiedModel(model)).toBe(model)
    }
  })

  test('served default model replaces the tier default when this build can run it', () => {
    servedDefault = { model: 'claude-mythos-5-1', orgConfigured: false }
    expect(getDefaultMainLoopModel()).toBe('claude-mythos-5-1')
    expect(getMainLoopModel()).toBe('claude-mythos-5-1')
    expect(getClaudeAiUserDefaultModelDescription()).toBe('Mythos 5.1')

    servedDefault = { model: 'claude-opus-5-5', orgConfigured: false }
    expect(getClaudeAiUserDefaultModelDescription()).toBe('Opus 5.5 · Best for everyday, complex tasks')

    servedDefault = { model: 'claude-mythos-5-1', orgConfigured: true }
    expect(getClaudeAiUserDefaultModelDescription()).toBe('Mythos 5.1 · Org default')

    settings = { model: 'sonnet' }
    expect(getMainLoopModel()).toBe('claude-sonnet-5-5')
  })

  test('served default yields to env overrides, aliases and models this build cannot run', () => {
    expect(getClaudeAiUserDefaultModelDescription()).toBe('Opus 5.5 · Best for everyday, complex tasks')

    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'custom-opus'
    servedDefault = { model: 'claude-mythos-5-1', orgConfigured: false }
    expect(getDefaultMainLoopModel()).toBe('custom-opus')
    delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL

    for (const model of ['sonnet', 'claude-haiku-9-9']) {
      servedDefault = { model, orgConfigured: false }
      expect(getDefaultMainLoopModel()).toBe('claude-opus-5-5')
    }

    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    servedDefault = { model: 'claude-mythos-5-1', orgConfigured: false }
    expect(getDefaultMainLoopModel()).not.toBe('claude-mythos-5-1')
  })

  test('ANTHROPIC_DEFAULT_MODEL sets the start model below explicit choices and org defaults', () => {
    process.env.ANTHROPIC_DEFAULT_MODEL = 'sonnet'
    expect(getDefaultMainLoopModel()).toBe('claude-sonnet-5-5')
    expect(getMainLoopModel()).toBe('claude-sonnet-5-5')

    servedDefault = { model: 'claude-mythos-5-1', orgConfigured: false }
    expect(getMainLoopModel()).toBe('claude-sonnet-5-5')
    servedDefault = { model: 'claude-mythos-5-1', orgConfigured: true }
    expect(getMainLoopModel()).toBe('claude-mythos-5-1')
    servedDefault = undefined

    settings = { model: 'haiku' }
    expect(getMainLoopModel()).toBe('claude-haiku-5-5')
    process.env.ANTHROPIC_MODEL = 'opus'
    expect(getMainLoopModel()).toBe('claude-opus-5-5')
    modelOverride = 'fable'
    expect(getMainLoopModel()).toBe('claude-fable-5-1')
    modelOverride = undefined
    delete process.env.ANTHROPIC_MODEL
    settings = {}

    for (const value of ['default', ' inherit ', '']) {
      process.env.ANTHROPIC_DEFAULT_MODEL = value
      expect(getDefaultMainLoopModel()).toBe('claude-opus-5-5')
    }

    settings = { availableModels: ['opus'] }
    process.env.ANTHROPIC_DEFAULT_MODEL = 'haiku'
    expect(getDefaultMainLoopModel()).toBe('claude-opus-5-5')
    settings = {}

    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.ANTHROPIC_DEFAULT_MODEL = 'gpt-5.4-mini'
    expect(getMainLoopModel()).toBe('gpt-5.4-mini')
  })

  test('fallback chain: CLI list beats the fallbackModel setting, resolves aliases, dedupes and caps at three', () => {
    expect(resolveFallbackModels(undefined, undefined)).toEqual([])
    expect(resolveFallbackModels(undefined, 'sonnet')).toEqual([])
    expect(resolveFallbackModels(undefined, ['sonnet', 'default', 'sonnet', 'custom-id', 'haiku'])).toEqual([
      'claude-sonnet-5-5', 'claude-opus-5-5', 'custom-id',
    ])
    expect(resolveFallbackModels(' haiku, ,sonnet ', ['opus'])).toEqual([
      'claude-haiku-5-5', 'claude-sonnet-5-5',
    ])
    settings = { availableModels: ['sonnet'] }
    expect(resolveFallbackModels('haiku,sonnet', undefined)).toEqual(['claude-sonnet-5-5'])
    settings = {}
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    expect(resolveFallbackModels('gpt-5.4-mini', undefined)).toEqual(['gpt-5.4-mini'])
  })

  test('helper model: Haiku on the Anthropic API, main loop model on a custom base URL (official 2.1.311)', () => {
    expect(getSmallFastModel()).toBe('claude-haiku-5-5')
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com'
    expect(getSmallFastModel()).toBe('claude-opus-5-5')
    settings = { model: 'sonnet' }
    expect(getSmallFastModel()).toBe('claude-sonnet-5-5')
    settings = {}
    apiKey = { key: 'sk-ant-api03-x', source: 'ANTHROPIC_API_KEY' }
    expect(getSmallFastModel()).toBe('claude-haiku-5-5')
    process.env.ANTHROPIC_AUTH_TOKEN = 'gw-token'
    expect(getSmallFastModel()).toBe('claude-opus-5-5')
    delete process.env.ANTHROPIC_AUTH_TOKEN
    apiKey = { key: 'gw-key', source: 'ANTHROPIC_API_KEY' }
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'Gateway/Haiku'
    expect(getSmallFastModel()).toBe('Gateway/Haiku')
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
    process.env.ANTHROPIC_SMALL_FAST_MODEL = 'Gateway/Small'
    expect(getSmallFastModel()).toBe('Gateway/Small')
    delete process.env.ANTHROPIC_SMALL_FAST_MODEL
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    expect(getSmallFastModel()).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0')
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
    expect(getMainLoopModel()).toBe('claude-opus-5-5')
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
    modelOverrides = { 'claude-opus-5-5': 'Gateway/Opus-Deployment' }
    expect(parseUserSpecifiedModel('opus')).toBe('Gateway/Opus-Deployment')
    expect(getCanonicalName('Gateway/Opus-Deployment')).toBe('claude-opus-5-5')
    expect(parseUserSpecifiedModel('Gateway/Other-Deployment')).toBe('Gateway/Other-Deployment')
  })

  test('canonical names, labels and plan descriptions match current and active legacy models', () => {
    expect(getCanonicalName('claude-opus-5-5')).toBe('claude-opus-5-5')
    expect(getCanonicalName('anthropic.claude-sonnet-5-5')).toBe('claude-sonnet-5-5')
    expect(getCanonicalName('claude-fable-5-1')).toBe('claude-fable-5-1')
    expect(getCanonicalName('claude-haiku-5-5')).toBe('claude-haiku-5-5')
    expect(getCanonicalName('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5')
    expect(ALL_MODEL_CONFIGS.mythos51).toEqual({
      firstParty: 'claude-mythos-5-1',
      bedrock: 'anthropic.claude-mythos-5-1',
      vertex: 'claude-mythos-5-1',
      foundry: 'claude-mythos-5-1',
    })
    expect(ALL_MODEL_CONFIGS.mythos50).toEqual({
      firstParty: 'claude-mythos-5',
      bedrock: 'anthropic.claude-mythos-5',
      vertex: 'claude-mythos-5',
      foundry: 'claude-mythos-5',
    })
    expect(getCanonicalName('anthropic.claude-mythos-5-1')).toBe('claude-mythos-5-1')
    expect(getCanonicalName('claude-mythos-preview')).toBe('claude-mythos-preview')
    expect(getCanonicalName('anthropic.claude-opus-4-8')).toBe('claude-opus-4-8')
    expect(getCanonicalName('anthropic.claude-opus-4-7')).toBe('claude-opus-4-7')
    expect(getPublicModelDisplayName('claude-opus-5-5')).toBe('Opus 5.5')
    expect(getPublicModelDisplayName('claude-mythos-5-1')).toBe('Mythos 5.1')
    expect(getPublicModelDisplayName('claude-mythos-preview')).toBe('Mythos Preview')
    expect(getPublicModelDisplayName('claude-haiku-5-5')).toBe('Haiku 5.5')
    expect(getMarketingNameForModel('claude-sonnet-5-5')).toBe('Sonnet 5.5')
    expect(getMarketingNameForModel('claude-fable-5-1')).toBe('Fable 5.1')
    expect(getMarketingNameForModel('claude-haiku-5-5')).toBe('Haiku 5.5')
    expect(getMarketingNameForModel('claude-mythos-5')).toBe('Mythos 5')
    expect(renderDefaultModelSetting('opusplan')).toBe('Opus 5.5 in plan mode, else Sonnet 5.5')
  })
})
