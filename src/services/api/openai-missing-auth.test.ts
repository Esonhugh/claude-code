#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const originalOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
const originalNodeEnv = process.env.NODE_ENV
const originalClaudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
const originalHome = process.env.HOME

try {
  const home = mkdtempSync(join(tmpdir(), 'openai-missing-auth-'))
  process.env.HOME = home
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token'
  process.env.NODE_ENV = 'test'

  const authModule = await import('../../utils/auth.js')
  authModule.getOpenAIAuthInfo.cache.clear?.()
  authModule.getOpenAIAuthInfo.cache.set(undefined, null)
  authModule.getOpenAIApiKey.cache.clear?.()

  const { getAnthropicClient } = await import('./client.js')

  await assert.rejects(
    async () => {
      await getAnthropicClient({
        maxRetries: 0,
      })
    },
    error => {
      assert.equal(error instanceof Error, true)
      assert.match(
        (error as Error).message,
        /Run \/login in an interactive session to sign in with OpenAI/,
      )
      assert.doesNotMatch((error as Error).message, /Create ~\/\.codex\/auth\.json/)
      return true
    },
  )
} finally {
  const authModule = await import('../../utils/auth.js')
  authModule.getOpenAIAuthInfo.cache.clear?.()
  if (originalOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
  else process.env.CLAUDE_CODE_USE_OPENAI = originalOpenAI
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
  if (originalClaudeToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalClaudeToken
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
}

console.log('openai-missing-auth.test.ts passed')
