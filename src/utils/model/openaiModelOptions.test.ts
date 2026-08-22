#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import axios from 'axios'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const originalHome = process.env.HOME
const originalOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
const originalAnthropicModel = process.env.ANTHROPIC_MODEL
const originalNodeEnv = process.env.NODE_ENV
const originalOpenAIBaseURL = process.env.OPENAI_BASE_URL
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
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.NODE_ENV = 'test'
  delete process.env.ANTHROPIC_MODEL

  const authModule = await import('../auth.js')
  const { saveGlobalConfig } = await import('../config.js')
  const openAIModelOptions = await import('./openaiModelOptions.js')
  const { getModelOptions } = await import('./modelOptions.js')

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

  saveGlobalConfig(current => ({
    ...current,
    additionalModelOptionsCache: [
      { value: 'gpt-online', label: 'GPT Online', description: 'From API' },
    ],
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
  assert.deepEqual(requests[0]!.params, { limit: 1000 })

  requests.length = 0
  delete process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY
  assert.equal(openAIModelOptions.isModelDiscoveryEnabled(), false)
  assert.equal(await openAIModelOptions.fetchModelOptions(), null)
  assert.equal(requests.length, 0)

  process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '1'
  delete process.env.ANTHROPIC_BASE_URL
  assert.equal(openAIModelOptions.isModelDiscoveryEnabled(), false)
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
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
  else process.env.CLAUDE_CODE_USE_OPENAI = originalOpenAI
  if (originalAnthropicModel === undefined) delete process.env.ANTHROPIC_MODEL
  else process.env.ANTHROPIC_MODEL = originalAnthropicModel
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
  if (originalOpenAIBaseURL === undefined) delete process.env.OPENAI_BASE_URL
  else process.env.OPENAI_BASE_URL = originalOpenAIBaseURL
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
