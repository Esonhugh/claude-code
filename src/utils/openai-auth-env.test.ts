#!/usr/bin/env node
import assert from 'node:assert/strict'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const originalOpenAIBaseToken = process.env.OPENAI_BASE_TOKEN

try {
  process.env.OPENAI_BASE_TOKEN = 'sk-env-token'

  const { getOpenAIAuthInfo, getOpenAIApiKey } = await import('./auth.js')
  getOpenAIAuthInfo.cache.clear?.()
  getOpenAIApiKey.cache.clear?.()

  assert.deepEqual(getOpenAIAuthInfo(), {
    accessToken: 'sk-env-token',
    isChatGPT: false,
  })
  assert.equal(getOpenAIApiKey(), 'sk-env-token')
} finally {
  const { getOpenAIAuthInfo, getOpenAIApiKey } = await import('./auth.js')
  getOpenAIAuthInfo.cache.clear?.()
  getOpenAIApiKey.cache.clear?.()
  if (originalOpenAIBaseToken === undefined) delete process.env.OPENAI_BASE_TOKEN
  else process.env.OPENAI_BASE_TOKEN = originalOpenAIBaseToken
}

console.log('openai-auth-env.test.ts passed')
