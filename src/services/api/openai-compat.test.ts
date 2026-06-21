#!/usr/bin/env node
import assert from 'node:assert/strict'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const originalFetch = globalThis.fetch
const originalOpenAIBaseURL = process.env.OPENAI_BASE_URL

try {
  const { getOpenAIAuthInfo } = await import('../../utils/auth.js')
  const { createOpenAICompatClient } = await import('./openai-compat.js')

  getOpenAIAuthInfo.cache.set(undefined, {
    accessToken: 'sk-test-api-key',
    isChatGPT: false,
  })

  process.env.OPENAI_BASE_URL = 'https://gateway.example.test/openai/v1'

  const requests: Array<{ url: string; authorization: string | null }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    requests.push({
      url: String(input),
      authorization: headers.get('authorization'),
    })
    return new Response(
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      },
    )
  }) as typeof fetch

  const client = createOpenAICompatClient({
    apiKey: 'sk-test-api-key',
    maxRetries: 0,
    timeout: 1000,
  })

  await client.beta.messages.create({
    model: 'gpt-5.5',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
  })

  assert.equal(
    requests[0]!.url,
    'https://gateway.example.test/openai/v1/responses',
  )
  assert.equal(requests[0]!.authorization, 'Bearer sk-test-api-key')

  requests.length = 0
  process.env.OPENAI_BASE_URL = 'https://gateway.example.test/'

  const rootURLClient = createOpenAICompatClient({
    apiKey: 'sk-test-api-key',
    maxRetries: 0,
    timeout: 1000,
  })

  await rootURLClient.beta.messages.create({
    model: 'gpt-5.5',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
  })

  assert.equal(requests[0]!.url, 'https://gateway.example.test/v1/responses')
} finally {
  globalThis.fetch = originalFetch
  const { getOpenAIAuthInfo } = await import('../../utils/auth.js')
  getOpenAIAuthInfo.cache.clear?.()
  if (originalOpenAIBaseURL === undefined) delete process.env.OPENAI_BASE_URL
  else process.env.OPENAI_BASE_URL = originalOpenAIBaseURL
}

console.log('openai-compat.test.ts passed')
