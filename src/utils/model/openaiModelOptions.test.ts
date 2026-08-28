#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import axios from 'axios'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const originalHome = process.env.HOME
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
const originalAnthropicModel = process.env.ANTHROPIC_MODEL
const originalNodeEnv = process.env.NODE_ENV
const originalOpenAIBaseURL = process.env.OPENAI_BASE_URL
const originalOpenAIAuthToken = process.env.OPENAI_AUTH_TOKEN
const originalOpenAIApiKey = process.env.OPENAI_API_KEY
const originalAnthropicBaseURL = process.env.ANTHROPIC_BASE_URL
const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
const originalAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN
const originalClaudeCodeOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
const originalGatewayDiscovery =
  process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY
const originalAxiosGet = axios.get
const tempHome = mkdtempSync(join(tmpdir(), 'claude-openai-model-options-'))

try {
  process.env.HOME = tempHome
  process.env.CLAUDE_CONFIG_DIR = tempHome
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.NODE_ENV = 'test'
  delete process.env.ANTHROPIC_MODEL
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_AUTH_TOKEN
  delete process.env.OPENAI_API_KEY

  const authModule = await import('../auth.js')
  const { setInitialMainLoopModel, setMainLoopModelOverride } = await import(
    '../../bootstrap/state.js'
  )
  const { saveGlobalConfig } = await import('../config.js')
  const { resetSettingsCache } = await import('../settings/settingsCache.js')
  const openAIModelOptions = await import('./openaiModelOptions.js')
  const { getModelOptions } = await import('./modelOptions.js')

  authModule.getOpenAIAuthInfo.cache.clear?.()
  authModule.getChatGPTOAuthInfo.cache.clear?.()
  setInitialMainLoopModel(null)
  setMainLoopModelOverride(undefined)
  resetSettingsCache()

  assert.deepEqual(
    openAIModelOptions.parseOpenAIModelOptions({
      data: [
        { id: 'gpt-5.6', display_name: 'GPT-5.6', description: 'Online' },
        { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
        { id: 'codex-auto-review', visibility: 'hide' },
        { id: 'gpt-disabled', supported_in_api: false },
      ],
    }),
    [
      { value: 'gpt-5.6', label: 'GPT-5.6', description: 'Online' },
      {
        value: 'codex-auto-review',
        label: 'codex-auto-review (Hidden)',
        description: 'Hidden by OpenAI; API support is enabled.',
      },
    ],
  )
  assert.deepEqual(
    openAIModelOptions.parseOpenAIModelOptions({
      models: [
        { slug: 'gpt-5.5', display_name: 'GPT-5.5' },
        {
          slug: 'codex-auto-review',
          visibility: 'hide',
          description: 'Internal review model',
        },
      ],
    }),
    [
      { value: 'gpt-5.5', label: 'GPT-5.5', description: 'OpenAI model' },
      {
        value: 'codex-auto-review',
        label: 'codex-auto-review (Hidden)',
        description:
          'Hidden by OpenAI; API support is enabled. Internal review model',
      },
    ],
  )

  assert.deepEqual(
    getModelOptions()
      .map(option => option.value)
      .filter(value => value === 'gpt-5.5' || value === 'gpt-5.4-mini'),
    ['gpt-5.5', 'gpt-5.4-mini'],
  )
  assert.equal(getModelOptions().some(option => option.value === 'sonnet'), false)
  assert.equal(getModelOptions().some(option => option.value === 'opus'), false)

  authModule.getOpenAIAuthInfo.cache.set(undefined, {
    accessToken: 'cached-api-token',
    isChatGPT: false,
  })
  const cachedDiscoveryKey =
    openAIModelOptions.getModelDiscoveryCacheKey() ?? undefined
  saveGlobalConfig(current => ({
    ...current,
    additionalModelOptionsCache: [],
    additionalModelOptionsCacheKey: cachedDiscoveryKey,
  }))
  assert.deepEqual(getModelOptions(), [])
  setMainLoopModelOverride('gpt-current-custom')
  assert.deepEqual(getModelOptions(), [
    {
      value: 'gpt-current-custom',
      label: 'gpt-current-custom',
      description: 'Custom model',
    },
  ])
  setMainLoopModelOverride(undefined)
  saveGlobalConfig(current => ({
    ...current,
    additionalModelOptionsCache: [
      { value: 'gpt-online', label: 'GPT Online', description: 'From API' },
    ],
    additionalModelOptionsCacheKey: cachedDiscoveryKey,
  }))
  assert.equal(getModelOptions()[0]?.value, 'gpt-online')

  const requests: Array<{
    url: string
    headers: Record<string, string> | undefined
    params: Record<string, string> | undefined
  }> = []
  axios.get = (async (
    url: string,
    options?: {
      headers?: Record<string, string>
      params?: Record<string, string>
    },
  ) => {
    requests.push({ url, headers: options?.headers, params: options?.params })
    return {
      data: {
        data: options?.headers?.['anthropic-version']
          ? [
              { id: 'anthropic/claude-gateway', name: 'Claude Gateway' },
              { id: 'openai/gpt-router', name: 'GPT Router' },
            ]
          : url.includes('openrouter.ai')
            ? [{ id: 'openai/gpt-router', name: 'GPT Router' }]
            : [{ id: 'gpt-api', display_name: 'GPT API' }],
      },
    }
  }) as typeof axios.get

  authModule.getOpenAIAuthInfo.cache.set(undefined, {
    accessToken: 'api-token',
    isChatGPT: false,
  })
  const apiCacheKey = openAIModelOptions.getModelDiscoveryCacheKey()
  assert.match(apiCacheKey ?? '', /^openai:https:\/\/api\.openai\.com\/v1:api:/)
  authModule.getOpenAIAuthInfo.cache.set(undefined, {
    accessToken: 'different-api-token',
    isChatGPT: false,
  })
  assert.notEqual(openAIModelOptions.getModelDiscoveryCacheKey(), apiCacheKey)
  authModule.getOpenAIAuthInfo.cache.set(undefined, {
    accessToken: 'api-token',
    isChatGPT: false,
  })
  process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api///'
  const openRouterCacheKey = openAIModelOptions.getModelDiscoveryCacheKey()
  assert.match(
    openRouterCacheKey ?? '',
    /^openai:https:\/\/openrouter\.ai\/api\/v1:api:/,
  )
  process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1/'
  assert.equal(openAIModelOptions.getModelDiscoveryCacheKey(), openRouterCacheKey)
  delete process.env.OPENAI_BASE_URL
  assert.deepEqual(await openAIModelOptions.fetchModelOptions(), [
    { value: 'gpt-api', label: 'GPT API', description: 'OpenAI model' },
  ])
  assert.equal(requests[0]!.url, 'https://api.openai.com/v1/models')
  assert.equal(requests[0]!.headers?.Authorization, 'Bearer api-token')

  requests.length = 0
  process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api'
  assert.deepEqual(await openAIModelOptions.fetchModelOptions(), [
    {
      value: 'openai/gpt-router',
      label: 'GPT Router',
      description: 'OpenAI model',
    },
  ])
  assert.equal(requests[0]!.url, 'https://openrouter.ai/api/v1/models')
  assert.equal(requests[0]!.headers?.Authorization, 'Bearer api-token')
  delete process.env.OPENAI_BASE_URL

  requests.length = 0
  authModule.getOpenAIAuthInfo.cache.set(undefined, {
    accessToken: 'chatgpt-token',
    accountId: 'account-123',
    isChatGPT: true,
  })
  const chatGPTCacheKey = openAIModelOptions.getModelDiscoveryCacheKey()
  assert.equal(chatGPTCacheKey, 'openai:chatgpt:account-123')
  authModule.getOpenAIAuthInfo.cache.set(undefined, {
    accessToken: 'chatgpt-token',
    accountId: 'account-456',
    isChatGPT: true,
  })
  assert.equal(
    openAIModelOptions.getModelDiscoveryCacheKey(),
    'openai:chatgpt:account-456',
  )
  authModule.getOpenAIAuthInfo.cache.set(undefined, {
    accessToken: 'chatgpt-token-without-account',
    isChatGPT: true,
  })
  assert.equal(
    openAIModelOptions.getModelDiscoveryCacheKey(),
    'openai:chatgpt:' +
      createHash('sha256')
        .update('chatgpt-token-without-account')
        .digest('hex')
        .slice(0, 16),
  )
  authModule.getOpenAIAuthInfo.cache.set(undefined, {
    accessToken: 'chatgpt-token',
    accountId: 'account-123',
    isChatGPT: true,
  })
  await openAIModelOptions.fetchModelOptions()
  assert.equal(requests[0]!.url, 'https://chatgpt.com/backend-api/codex/models')
  assert.equal(requests[0]!.headers?.['chatgpt-account-id'], 'account-123')
  assert.deepEqual(requests[0]!.params, { client_version: 'test' })

  requests.length = 0
  delete process.env.CLAUDE_CODE_USE_OPENAI
  process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '1'
  process.env.ANTHROPIC_BASE_URL = 'https://openrouter.ai/api'
  process.env.ANTHROPIC_API_KEY = 'gateway-key'
  delete process.env.ANTHROPIC_AUTH_TOKEN
  const gatewayCacheKey =
    'anthropic:https://openrouter.ai/api/v1:api-key:' +
    createHash('sha256').update('gateway-key').digest('hex').slice(0, 16)
  assert.equal(
    openAIModelOptions.getModelDiscoveryCacheKey(),
    gatewayCacheKey,
  )
  process.env.ANTHROPIC_BASE_URL = 'https://openrouter.ai/api/v1/'
  assert.equal(
    openAIModelOptions.getModelDiscoveryCacheKey(),
    gatewayCacheKey,
  )
  process.env.ANTHROPIC_API_KEY = 'different-gateway-key'
  assert.notEqual(
    openAIModelOptions.getModelDiscoveryCacheKey(),
    gatewayCacheKey,
  )
  process.env.ANTHROPIC_API_KEY = 'gateway-key'
  process.env.ANTHROPIC_BASE_URL = 'https://openrouter.ai/api'
  assert.deepEqual(await openAIModelOptions.fetchModelOptions(), [
    {
      value: 'anthropic/claude-gateway',
      label: 'Claude Gateway',
      description: 'From gateway',
    },
    {
      value: 'openai/gpt-router',
      label: 'GPT Router',
      description: 'From gateway',
    },
  ])
  assert.equal(requests[0]!.url, 'https://openrouter.ai/api/v1/models')
  assert.equal(requests[0]!.headers?.['x-api-key'], 'gateway-key')
  assert.equal(requests[0]!.params, undefined)

  const gatewayOptions = [
    {
      value: 'anthropic/claude-gateway',
      label: 'Claude Gateway',
      description: 'From gateway',
    },
    {
      value: 'openai/gpt-router',
      label: 'GPT Router',
      description: 'From gateway',
    },
  ]
  saveGlobalConfig(current => ({
    ...current,
    additionalModelOptionsCache: gatewayOptions,
    additionalModelOptionsCacheKey: gatewayCacheKey,
  }))
  assert.deepEqual(getModelOptions(), gatewayOptions)

  requests.length = 0
  delete process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY
  assert.equal(openAIModelOptions.isModelDiscoveryEnabled(), false)
  assert.equal(await openAIModelOptions.fetchModelOptions(), null)
  assert.equal(requests.length, 0)

  const firstPartyBootstrapOption = {
    value: 'claude-bootstrap-extra',
    label: 'Claude Bootstrap Extra',
    description: 'From first-party bootstrap',
  }
  saveGlobalConfig(current => ({
    ...current,
    additionalModelOptionsCache: [firstPartyBootstrapOption],
    additionalModelOptionsCacheKey: undefined,
  }))
  assert.equal(
    getModelOptions().some(
      option => option.value === firstPartyBootstrapOption.value,
    ),
    true,
  )

  process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '1'
  delete process.env.ANTHROPIC_BASE_URL
  assert.equal(openAIModelOptions.isModelDiscoveryEnabled(), false)
  assert.equal(
    getModelOptions().some(option => option.value === 'anthropic/claude-gateway'),
    false,
  )
  assert.equal(
    getModelOptions().some(option => option.value === 'openai/gpt-router'),
    false,
  )
  assert.equal(await openAIModelOptions.fetchModelOptions(), null)
  assert.equal(requests.length, 0)

  process.env.ANTHROPIC_BASE_URL = 'https://gateway.example'
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'unsupported-gateway-oauth-token'
  assert.equal(openAIModelOptions.isModelDiscoveryEnabled(), true)
  assert.equal(await openAIModelOptions.fetchModelOptions(), null)
  assert.equal(requests.length, 0)

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  authModule.getOpenAIAuthInfo.cache.set(undefined, {
    accessToken: 'api-token',
    isChatGPT: false,
  })
  axios.get = (async () => {
    throw new Error('network unavailable')
  }) as typeof axios.get
  assert.equal(await openAIModelOptions.fetchModelOptions(), null)
} finally {
  axios.get = originalAxiosGet
  const authModule = await import('../auth.js')
  authModule.getOpenAIAuthInfo.cache.clear?.()
  authModule.getChatGPTOAuthInfo.cache.clear?.()
  const { setInitialMainLoopModel, setMainLoopModelOverride } = await import(
    '../../bootstrap/state.js'
  )
  const { resetSettingsCache } = await import('../settings/settingsCache.js')
  setInitialMainLoopModel(null)
  setMainLoopModelOverride(undefined)
  resetSettingsCache()
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (originalOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
  else process.env.CLAUDE_CODE_USE_OPENAI = originalOpenAI
  if (originalAnthropicModel === undefined) delete process.env.ANTHROPIC_MODEL
  else process.env.ANTHROPIC_MODEL = originalAnthropicModel
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
  if (originalOpenAIBaseURL === undefined) delete process.env.OPENAI_BASE_URL
  else process.env.OPENAI_BASE_URL = originalOpenAIBaseURL
  if (originalOpenAIAuthToken === undefined) delete process.env.OPENAI_AUTH_TOKEN
  else process.env.OPENAI_AUTH_TOKEN = originalOpenAIAuthToken
  if (originalOpenAIApiKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = originalOpenAIApiKey
  if (originalAnthropicBaseURL === undefined) delete process.env.ANTHROPIC_BASE_URL
  else process.env.ANTHROPIC_BASE_URL = originalAnthropicBaseURL
  if (originalAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
  if (originalAnthropicAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN
  else process.env.ANTHROPIC_AUTH_TOKEN = originalAnthropicAuthToken
  if (originalClaudeCodeOAuthToken === undefined) {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  } else {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = originalClaudeCodeOAuthToken
  }
  if (originalGatewayDiscovery === undefined) {
    delete process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY
  } else {
    process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY =
      originalGatewayDiscovery
  }
  rmSync(tempHome, { recursive: true, force: true })
}

console.log('openaiModelOptions.test.ts passed')
