#!/usr/bin/env node
import assert from 'node:assert/strict'
import axios from 'axios'

const originalAxiosGet = axios.get
const originalOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
const originalNodeEnv = process.env.NODE_ENV
const originalAnthropicBaseURL = process.env.ANTHROPIC_BASE_URL
const originalAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN
const originalGatewayDiscovery =
  process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY
let restoreGlobalConfig: (() => void) | undefined

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

try {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.NODE_ENV = 'test'

  const authModule = await import('../../utils/auth.js')
  const { getGlobalConfig, saveGlobalConfig } = await import('../../utils/config.js')
  const { fetchBootstrapData } = await import('./bootstrap.js')
  const originalModelOptionsCache = getGlobalConfig().additionalModelOptionsCache
  restoreGlobalConfig = () => {
    saveGlobalConfig(current => ({
      ...current,
      additionalModelOptionsCache: originalModelOptionsCache,
    }))
  }

  saveGlobalConfig(current => ({
    ...current,
    additionalModelOptionsCache: undefined,
  }))
  authModule.getOpenAIAuthInfo.cache.set(undefined, {
    accessToken: 'test-token',
    accountId: 'account-123',
    isChatGPT: true,
  })

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
          ? [{ id: 'anthropic/claude-bootstrap', display_name: 'Claude Bootstrap' }]
          : [{ id: 'gpt-bootstrap', display_name: 'GPT Bootstrap' }],
      },
    }
  }) as typeof axios.get

  await fetchBootstrapData()

  assert.equal(requests[0]!.url, 'https://chatgpt.com/backend-api/codex/models')
  assert.equal(
    requests[0]!.headers?.['chatgpt-account-id'],
    'account-123',
  )
  assert.deepEqual(requests[0]!.params, { client_version: 'test' })
  assert.deepEqual(getGlobalConfig().additionalModelOptionsCache, [
    { value: 'gpt-bootstrap', label: 'GPT Bootstrap', description: 'OpenAI model' },
  ])

  requests.length = 0
  delete process.env.CLAUDE_CODE_USE_OPENAI
  process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '1'
  process.env.ANTHROPIC_BASE_URL = 'https://gateway.example'
  process.env.ANTHROPIC_AUTH_TOKEN = 'gateway-token'
  await fetchBootstrapData()

  assert.equal(requests[0]!.url, 'https://gateway.example/v1/models')
  assert.equal(requests[0]!.headers?.Authorization, 'Bearer gateway-token')
  assert.deepEqual(getGlobalConfig().additionalModelOptionsCache, [
    {
      value: 'anthropic/claude-bootstrap',
      label: 'Claude Bootstrap',
      description: 'From gateway',
    },
  ])

  saveGlobalConfig(current => ({
    ...current,
    additionalModelOptionsCache: [
      {
        value: 'cached-model',
        label: 'Cached Model',
        description: 'Keep on discovery failure',
      },
    ],
  }))
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  axios.get = (async () => {
    throw new Error('network unavailable')
  }) as typeof axios.get

  await fetchBootstrapData()

  assert.deepEqual(getGlobalConfig().additionalModelOptionsCache, [
    {
      value: 'cached-model',
      label: 'Cached Model',
      description: 'Keep on discovery failure',
    },
  ])
} finally {
  restoreGlobalConfig?.()
  axios.get = originalAxiosGet
  const authModule = await import('../../utils/auth.js')
  authModule.getOpenAIAuthInfo.cache.clear?.()
  if (originalOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
  else process.env.CLAUDE_CODE_USE_OPENAI = originalOpenAI
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
  if (originalAnthropicBaseURL === undefined) delete process.env.ANTHROPIC_BASE_URL
  else process.env.ANTHROPIC_BASE_URL = originalAnthropicBaseURL
  if (originalAnthropicAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN
  else process.env.ANTHROPIC_AUTH_TOKEN = originalAnthropicAuthToken
  if (originalGatewayDiscovery === undefined) {
    delete process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY
  } else {
    process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY =
      originalGatewayDiscovery
  }
}

console.log('bootstrap-openai.test.ts passed')
