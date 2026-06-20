#!/usr/bin/env node
import assert from 'node:assert/strict'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const authModule = await import('./utils/auth.js')
const { shouldShowOpenAIAutoLogin } = await import('./utils/openaiAutoLogin.js')

const originalUseOpenAI = process.env.CLAUDE_CODE_USE_OPENAI

try {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  authModule.getOpenAIApiKey.cache.set(undefined, null)
  assert.equal(shouldShowOpenAIAutoLogin(), true)

  authModule.getOpenAIApiKey.cache.set(undefined, 'access-token')
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
  authModule.getOpenAIApiKey.cache.clear?.()
}

console.log('interactiveHelpers.openai-auth.test.ts passed')
