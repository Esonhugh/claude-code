#!/usr/bin/env node
import assert from 'node:assert/strict'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const originalOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
const originalNodeEnv = process.env.NODE_ENV
const originalClaudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN

try {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token'
  process.env.NODE_ENV = 'test'
  const { getCommands } = await import('../../commands.js')
  const commands = await getCommands(process.cwd())
  assert.equal(commands.some(command => command.name === 'login'), true)
} finally {
  if (originalOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
  else process.env.CLAUDE_CODE_USE_OPENAI = originalOpenAI
  if (originalClaudeToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalClaudeToken
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
}

console.log('openai-login-availability.test.ts passed')
