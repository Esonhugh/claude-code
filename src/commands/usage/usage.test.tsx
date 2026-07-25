#!/usr/bin/env node
import assert from 'node:assert/strict'
import * as React from 'react'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const originalOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
const originalNodeEnv = process.env.NODE_ENV

let authModule: typeof import('../../utils/auth.js') | undefined

try {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.NODE_ENV = 'test'

  authModule = await import('../../utils/auth.js')
  const usageCommand = (await import('./index.js')).default
  const { meetsAvailabilityRequirement } = await import('../../commands.js')
  const { call } = await import('./usage.js')

  authModule.getOpenAIAuthInfo.cache.set(undefined, {
    accessToken: 'test-token',
    accountId: 'account-123',
    isChatGPT: true,
    planType: 'pro',
  })

  assert.deepEqual(
    new Set(usageCommand.availability),
    new Set(['chatgpt', 'claude-ai']),
  )
  assert.equal(meetsAvailabilityRequirement(usageCommand), true)
  assert.equal(usageCommand.immediate, true)

  authModule.getOpenAIAuthInfo.cache.set(undefined, {
    accessToken: 'test-api-key',
    isChatGPT: false,
  })
  assert.equal(meetsAvailabilityRequirement(usageCommand), false)

  const element = await call(() => {}, {} as never, '')
  assert.equal(React.isValidElement(element), true)
  assert.equal(
    (element as React.ReactElement<{ defaultTab: string }>).props.defaultTab,
    'Usage',
  )
} finally {
  authModule?.getOpenAIAuthInfo.cache.clear?.()
  if (originalOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
  else process.env.CLAUDE_CODE_USE_OPENAI = originalOpenAI
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
}

console.log('usage.test.tsx passed')
