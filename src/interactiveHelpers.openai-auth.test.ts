#!/usr/bin/env node
import assert from 'node:assert/strict'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const authModule = await import('./utils/auth.js')
const { shouldShowOpenAIAutoLogin } = await import('./utils/openaiAutoLogin.js')

const originalUseOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
const originalOpenAIBaseToken = process.env.OPENAI_AUTH_TOKEN

try {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  authModule.getOpenAIApiKey.cache.set(undefined, null)
  assert.equal(shouldShowOpenAIAutoLogin(), true)

  authModule.getOpenAIApiKey.cache.set(undefined, 'access-token')
  assert.equal(shouldShowOpenAIAutoLogin(), false)

  authModule.getOpenAIApiKey.cache.clear?.()
  authModule.getOpenAIAuthInfo.cache.clear?.()
  process.env.OPENAI_AUTH_TOKEN = 'sk-env-token'
  assert.equal(shouldShowOpenAIAutoLogin(), false)

  process.env.CLAUDE_CODE_USE_OPENAI = '0'
  authModule.getOpenAIApiKey.cache.set(undefined, null)
  assert.equal(shouldShowOpenAIAutoLogin(), false)
} finally {
  if (originalUseOpenAI === undefined) {
    delete process.env.CLAUDE_CODE_USE_OPENAI
  } else {
    process.env.CLAUDE_CODE_USE_OPENAI = originalUseOpenAI
  }
  if (originalOpenAIBaseToken === undefined) {
    delete process.env.OPENAI_AUTH_TOKEN
  } else {
    process.env.OPENAI_AUTH_TOKEN = originalOpenAIBaseToken
  }
  authModule.getOpenAIApiKey.cache.clear?.()
  authModule.getOpenAIAuthInfo.cache.clear?.()
}

console.log('interactiveHelpers.openai-auth.test.ts passed')
