#!/usr/bin/env node
import assert from 'node:assert/strict'

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

function resetProviderEnv(): void {
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.ANTHROPIC_BASE_URL
}

try {
  resetProviderEnv()
  const { buildFetch } = await import('./client.js')

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
  assert.equal(oauthHeaders.get('user-agent'), 'claude-cli/2.1.280 (external, cli)')
  assert.equal(oauthHeaders.get('x-stainless-lang'), 'js')
  assert.equal(oauthHeaders.get('x-stainless-package-version'), '0.112.1')
  assert.equal(oauthHeaders.get('x-stainless-runtime'), 'node')
  assert.equal(oauthHeaders.get('x-stainless-runtime-version'), 'v26.3.0')
  assert.equal(oauthHeaders.get('x-stainless-retry-count'), '0')
  assert.equal(oauthHeaders.get('x-stainless-timeout'), '600')
  assert.equal(oauthHeaders.get('authorization'), 'Bearer test-oauth-token')
  assert.equal(oauthHeaders.get('x-api-key'), null)

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
  assert.notEqual(apiKeyHeaders.get('user-agent'), 'claude-cli/2.1.280 (external, cli)')
  assert.notEqual(apiKeyHeaders.get('x-stainless-package-version'), '0.112.1')
} finally {
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
  const authModule = await import('../../utils/auth.js')
  authModule.getClaudeAIOAuthTokens.cache.clear?.()
}

console.log('cchFetch.test.ts passed')
