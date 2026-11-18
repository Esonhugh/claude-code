#!/usr/bin/env node
import assert from 'node:assert/strict'
import { DEFAULT_CLIENT_VERSIONS } from '../../constants/clientVersions.js'
import { getSessionSettingsCache, setSessionSettingsCache } from '../../utils/settings/settingsCache.js'
import { runWithWorkload } from '../../utils/workloadContext.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const originalOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
const originalBedrock = process.env.CLAUDE_CODE_USE_BEDROCK
const originalVertex = process.env.CLAUDE_CODE_USE_VERTEX
const originalFoundry = process.env.CLAUDE_CODE_USE_FOUNDRY
const originalBaseUrl = process.env.ANTHROPIC_BASE_URL
const originalOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
const originalApiKey = process.env.ANTHROPIC_API_KEY
const originalCustomHeaders = process.env.ANTHROPIC_CUSTOM_HEADERS
const originalEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
const originalAgentSdkVersion = process.env.CLAUDE_AGENT_SDK_VERSION
const originalClientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP
const originalSettings = getSessionSettingsCache()

function resetProviderEnv(): void {
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.ANTHROPIC_BASE_URL
}

try {
  setSessionSettingsCache({ settings: {}, errors: [] })
  resetProviderEnv()
  const { buildFetch, getAnthropicClient } = await import('./client.js')

  const sentBodies: string[] = []
  const fetch = buildFetch((async (_input: RequestInfo | URL, init?: RequestInit) => {
    sentBodies.push(String(init?.body))
    return new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof globalThis.fetch, 'cch_fetch_test')

  const body = JSON.stringify({
    system: [
      {
        type: 'text',
        text: 'x-anthropic-billing-header: cc_version=2.1.185.abc; cc_entrypoint=cli; cch=00000;',
      },
    ],
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'literal cch=00000 remains' }],
    max_tokens: 1024,
  })

  await fetch('https://api.anthropic.com/v1/messages?beta=true', {
    method: 'POST',
    body,
  })
  assert.match(
    sentBodies[0]!,
    /x-anthropic-billing-header:[^\n]*cch=[0-9a-f]{5};/,
  )
  assert.ok(!sentBodies[0]!.includes('cc_entrypoint=cli; cch=00000;'))
  assert.ok(sentBodies[0]!.includes('literal cch=00000 remains'))

  sentBodies.length = 0
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  const openAIFetch = buildFetch((async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    sentBodies.push(String(init?.body))
    return new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof globalThis.fetch, 'cch_fetch_test')
  await openAIFetch('https://api.anthropic.com/v1/messages?beta=true', {
    method: 'POST',
    body,
  })
  assert.equal(sentBodies[0], body)

  sentBodies.length = 0
  resetProviderEnv()
  process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.test'
  const proxyFetch = buildFetch((async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    sentBodies.push(String(init?.body))
    return new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof globalThis.fetch, 'cch_fetch_test')
  await proxyFetch('https://proxy.example.test/v1/messages?beta=true', {
    method: 'POST',
    body,
  })
  assert.notEqual(sentBodies[0], body)
  assert.ok(!sentBodies[0]!.includes('cc_entrypoint=cli; cch=00000;'))

  resetProviderEnv()
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
  delete process.env.CLAUDE_AGENT_SDK_VERSION
  delete process.env.CLAUDE_AGENT_SDK_CLIENT_APP
  delete process.env.CLAUDE_CODE_ENTRYPOINT
  // An API key in the environment would outrank the OAuth token.
  delete process.env.ANTHROPIC_API_KEY
  const authModule = await import('../../utils/auth.js')
  authModule.getClaudeAIOAuthTokens.cache.clear?.()
  const oauthRequests: Request[] = []
  const oauthClient = await (await import('./client.js')).getAnthropicClient({
    maxRetries: 0,
    fetchOverride: (async (input: RequestInfo | URL, init?: RequestInit) => {
      oauthRequests.push(new Request(input, init))
      return new Response(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-sonnet-4-6',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as typeof globalThis.fetch,
  })
  await oauthClient.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'test' }],
  })
  const oauthHeaders = oauthRequests[0]!.headers
  assert.equal(oauthHeaders.get('user-agent'), `claude-cli/${DEFAULT_CLIENT_VERSIONS.ClaudeOAuthClientVersion} (external, cli)`)
  assert.equal(oauthHeaders.get('x-stainless-lang'), 'js')
  assert.equal(oauthHeaders.get('x-stainless-package-version'), '0.128.0')
  assert.equal(oauthHeaders.get('x-stainless-runtime'), 'node')
  assert.equal(oauthHeaders.get('x-stainless-runtime-version'), 'v26.12.1')
  assert.equal(oauthHeaders.get('x-stainless-retry-count'), '0')
  assert.equal(oauthHeaders.get('x-stainless-timeout'), '600')
  assert.equal(oauthHeaders.get('authorization'), 'Bearer test-oauth-token')
  assert.equal(oauthHeaders.get('x-api-key'), null)

  process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-cli'
  process.env.CLAUDE_AGENT_SDK_VERSION = 'test-sdk'
  process.env.CLAUDE_AGENT_SDK_CLIENT_APP = 'test-app'
  const sdkClient = await runWithWorkload('cron', () => getAnthropicClient({
    maxRetries: 0,
    fetchOverride: (async (input: RequestInfo | URL, init?: RequestInit) => {
      oauthRequests.push(new Request(input, init))
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof globalThis.fetch,
  }))
  await sdkClient.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'test' }],
  })
  assert.equal(oauthRequests[1]!.headers.get('user-agent'),
    `claude-cli/${DEFAULT_CLIENT_VERSIONS.ClaudeOAuthClientVersion} (external, sdk-cli, agent-sdk/test-sdk, client-app/test-app, workload/cron)`)
  delete process.env.CLAUDE_CODE_ENTRYPOINT
  delete process.env.CLAUDE_AGENT_SDK_VERSION
  delete process.env.CLAUDE_AGENT_SDK_CLIENT_APP

  setSessionSettingsCache({ settings: { versionNumber: { ClaudeOAuthClientVersion: 'oauth-custom', ClaudeSDKVersion: 'sdk-custom' } }, errors: [] })
  const customOAuthRequests: Request[] = []
  const customOAuthClient = await getAnthropicClient({
    maxRetries: 0,
    fetchOverride: (async (input: RequestInfo | URL, init?: RequestInit) => {
      customOAuthRequests.push(new Request(input, init))
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof globalThis.fetch,
  })
  await customOAuthClient.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 1, messages: [{ role: 'user', content: 'test' }] })
  assert.equal(customOAuthRequests[0]!.headers.get('user-agent'), 'claude-cli/oauth-custom (external, cli)')
  assert.equal(customOAuthRequests[0]!.headers.get('x-stainless-package-version'), 'sdk-custom')

  process.env.ANTHROPIC_CUSTOM_HEADERS = [
    'User-Agent: custom-agent',
    'X-Stainless-Runtime: custom-runtime',
  ].join('\n')
  const overrideRequests: Request[] = []
  const overrideClient = await (await import('./client.js')).getAnthropicClient({
    maxRetries: 0,
    fetchOverride: (async (input: RequestInfo | URL, init?: RequestInit) => {
      overrideRequests.push(new Request(input, init))
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof globalThis.fetch,
  })
  await overrideClient.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'test' }],
  })
  assert.equal(overrideRequests[0]!.headers.get('user-agent'), 'custom-agent')
  assert.equal(overrideRequests[0]!.headers.get('x-stainless-runtime'), 'custom-runtime')

  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  process.env.ANTHROPIC_API_KEY = 'test-api-key-env'
  delete process.env.ANTHROPIC_CUSTOM_HEADERS
  setSessionSettingsCache({ settings: {}, errors: [] })
  authModule.getClaudeAIOAuthTokens.cache.clear?.()
  const apiKeyRequests: Request[] = []
  const apiKeyClient = await (await import('./client.js')).getAnthropicClient({
    apiKey: 'test-api-key',
    maxRetries: 0,
    fetchOverride: (async (input: RequestInfo | URL, init?: RequestInit) => {
      apiKeyRequests.push(new Request(input, init))
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof globalThis.fetch,
  })
  await apiKeyClient.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'test' }],
  })
  const apiKeyHeaders = apiKeyRequests[0]!.headers
  assert.equal(apiKeyHeaders.get('x-api-key'), 'test-api-key')
  assert.equal(apiKeyHeaders.get('user-agent'), 'claude-cli/2.1.327 (external, cli)')
  assert.equal(apiKeyHeaders.get('x-stainless-package-version'), '0.128.0')
  setSessionSettingsCache({ settings: { versionNumber: { ClaudeApiClientVersion: 'api-custom', ClaudeSDKVersion: 'sdk-api-custom' } }, errors: [] })
  const customApiClient = await getAnthropicClient({
    apiKey: 'test-api-key', maxRetries: 0,
    fetchOverride: (async (input: RequestInfo | URL, init?: RequestInit) => {
      apiKeyRequests.push(new Request(input, init))
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof globalThis.fetch,
  })
  await customApiClient.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 1, messages: [{ role: 'user', content: 'test' }] })
  assert.equal(apiKeyRequests[1]!.headers.get('user-agent'), 'claude-cli/api-custom (external, cli)')
  assert.equal(apiKeyRequests[1]!.headers.get('x-stainless-package-version'), 'sdk-api-custom')
} finally {
  if (originalSettings) setSessionSettingsCache(originalSettings)
  else (await import('../../utils/settings/settingsCache.js')).resetSettingsCache()
  resetProviderEnv()
  if (originalOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
  else process.env.CLAUDE_CODE_USE_OPENAI = originalOpenAI
  if (originalBedrock === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK
  else process.env.CLAUDE_CODE_USE_BEDROCK = originalBedrock
  if (originalVertex === undefined) delete process.env.CLAUDE_CODE_USE_VERTEX
  else process.env.CLAUDE_CODE_USE_VERTEX = originalVertex
  if (originalFoundry === undefined) delete process.env.CLAUDE_CODE_USE_FOUNDRY
  else process.env.CLAUDE_CODE_USE_FOUNDRY = originalFoundry
  if (originalBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
  else process.env.ANTHROPIC_BASE_URL = originalBaseUrl
  if (originalOAuthToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOAuthToken
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = originalApiKey
  if (originalCustomHeaders === undefined) delete process.env.ANTHROPIC_CUSTOM_HEADERS
  else process.env.ANTHROPIC_CUSTOM_HEADERS = originalCustomHeaders
  if (originalEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT
  else process.env.CLAUDE_CODE_ENTRYPOINT = originalEntrypoint
  if (originalAgentSdkVersion === undefined) delete process.env.CLAUDE_AGENT_SDK_VERSION
  else process.env.CLAUDE_AGENT_SDK_VERSION = originalAgentSdkVersion
  if (originalClientApp === undefined) delete process.env.CLAUDE_AGENT_SDK_CLIENT_APP
  else process.env.CLAUDE_AGENT_SDK_CLIENT_APP = originalClientApp
  const authModule = await import('../../utils/auth.js')
  authModule.getClaudeAIOAuthTokens.cache.clear?.()
}

console.log('cchFetch.test.ts passed')
