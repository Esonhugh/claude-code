#!/usr/bin/env node
import assert from 'node:assert/strict'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const originalNodeEnv = process.env.NODE_ENV
const originalOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
const originalOpenAIAPIKey = process.env.OPENAI_API_KEY
const originalDisableFastMode = process.env.CLAUDE_CODE_DISABLE_FAST_MODE

try {
  process.env.NODE_ENV = 'test'
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_API_KEY = 'test-api-key'
  delete process.env.CLAUDE_CODE_DISABLE_FAST_MODE

  const fastCommand = (await import('../commands/fast/index.js')).default
  const { meetsAvailabilityRequirement } = await import('../commands.js')
  const {
    getFastModeUnavailableReason,
    isFastModeSupportedByModel,
    prefetchFastModeStatus,
  } = await import('./fastMode.js')

  assert.deepEqual(fastCommand.availability, [
    'claude-ai',
    'console',
    'chatgpt',
  ])
  assert.equal(getFastModeUnavailableReason(), null)
  assert.equal(meetsAvailabilityRequirement(fastCommand), true)
  assert.equal(isFastModeSupportedByModel('gpt-5.5'), true)
  assert.equal(isFastModeSupportedByModel('gpt-unknown'), true)
  await prefetchFastModeStatus()
} finally {
  const authModule = await import('./auth.js')
  authModule.getOpenAIAuthInfo.cache.clear?.()
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
  if (originalOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
  else process.env.CLAUDE_CODE_USE_OPENAI = originalOpenAI
  if (originalOpenAIAPIKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = originalOpenAIAPIKey
  if (originalDisableFastMode === undefined) {
    delete process.env.CLAUDE_CODE_DISABLE_FAST_MODE
  } else {
    process.env.CLAUDE_CODE_DISABLE_FAST_MODE = originalDisableFastMode
  }
}

console.log('fastMode.openai.test.ts passed')
