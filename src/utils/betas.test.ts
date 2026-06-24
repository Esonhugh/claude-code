#!/usr/bin/env node
import assert from 'node:assert/strict'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const originalNodeEnv = process.env.NODE_ENV
const originalApiKey = process.env.ANTHROPIC_API_KEY
const originalDisableExperimental = process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
const originalBetas = process.env.ANTHROPIC_BETAS
const originalUseOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
const originalUseBedrock = process.env.CLAUDE_CODE_USE_BEDROCK
const originalUseVertex = process.env.CLAUDE_CODE_USE_VERTEX
const originalUseFoundry = process.env.CLAUDE_CODE_USE_FOUNDRY

try {
  process.env.NODE_ENV = 'test'
  process.env.ANTHROPIC_API_KEY = 'test-key'
  delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
  delete process.env.ANTHROPIC_BETAS
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY

  const { setIsInteractive } = await import('../bootstrap/state.js')
  const { getAllModelBetas } = await import('./betas.js')
  const { THINKING_TOKEN_COUNT_BETA_HEADER } = await import('../constants/betas.js')

  setIsInteractive(true)
  const betas = getAllModelBetas('claude-sonnet-4-6')
  assert.equal(betas.includes(THINKING_TOKEN_COUNT_BETA_HEADER), true)
} finally {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv

  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = originalApiKey

  if (originalDisableExperimental === undefined) {
    delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
  } else {
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = originalDisableExperimental
  }
  if (originalBetas === undefined) delete process.env.ANTHROPIC_BETAS
  else process.env.ANTHROPIC_BETAS = originalBetas

  if (originalUseOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
  else process.env.CLAUDE_CODE_USE_OPENAI = originalUseOpenAI

  if (originalUseBedrock === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK
  else process.env.CLAUDE_CODE_USE_BEDROCK = originalUseBedrock

  if (originalUseVertex === undefined) delete process.env.CLAUDE_CODE_USE_VERTEX
  else process.env.CLAUDE_CODE_USE_VERTEX = originalUseVertex

  if (originalUseFoundry === undefined) delete process.env.CLAUDE_CODE_USE_FOUNDRY
  else process.env.CLAUDE_CODE_USE_FOUNDRY = originalUseFoundry
}

console.log('betas.test.ts passed')
