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
}

console.log('cchFetch.test.ts passed')
