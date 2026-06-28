#!/usr/bin/env node
import assert from 'node:assert/strict'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const originalOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
const originalBedrock = process.env.CLAUDE_CODE_USE_BEDROCK
const originalVertex = process.env.CLAUDE_CODE_USE_VERTEX
const originalFoundry = process.env.CLAUDE_CODE_USE_FOUNDRY
const originalEffort = process.env.CLAUDE_CODE_EFFORT_LEVEL

function resetEnv(): void {
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.CLAUDE_CODE_EFFORT_LEVEL
}

try {
  resetEnv()
  const { configureEffortParams } = await import('./claude.js')

  const outputConfig: { effort?: string } = {}
  const betas: string[] = []
  configureEffortParams(undefined, outputConfig, {}, betas, 'gpt-5.5')

  assert.equal(outputConfig.effort, 'high')
  assert.ok(betas.length > 0)

  const explicitOutputConfig: { effort?: string } = {}
  const explicitBetas: string[] = []
  configureEffortParams('medium', explicitOutputConfig, {}, explicitBetas, 'gpt-5.5')

  assert.equal(explicitOutputConfig.effort, 'medium')
  assert.ok(explicitBetas.length > 0)

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  const openAIOutputConfig: { effort?: string } = {}
  const openAIBetas: string[] = []
  configureEffortParams(undefined, openAIOutputConfig, {}, openAIBetas, 'gpt-5.5')

  assert.equal(openAIOutputConfig.effort, undefined)
  assert.equal(openAIBetas.length, 0)

  delete process.env.CLAUDE_CODE_USE_OPENAI
  process.env.CLAUDE_CODE_USE_BEDROCK = '1'
  const bedrockOutputConfig: { effort?: string } = {}
  const bedrockBetas: string[] = []
  configureEffortParams(undefined, bedrockOutputConfig, {}, bedrockBetas, 'gpt-5.5')

  assert.equal(bedrockOutputConfig.effort, undefined)
} finally {
  resetEnv()
  if (originalOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
  else process.env.CLAUDE_CODE_USE_OPENAI = originalOpenAI
  if (originalBedrock === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK
  else process.env.CLAUDE_CODE_USE_BEDROCK = originalBedrock
  if (originalVertex === undefined) delete process.env.CLAUDE_CODE_USE_VERTEX
  else process.env.CLAUDE_CODE_USE_VERTEX = originalVertex
  if (originalFoundry === undefined) delete process.env.CLAUDE_CODE_USE_FOUNDRY
  else process.env.CLAUDE_CODE_USE_FOUNDRY = originalFoundry
  if (originalEffort === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL
  else process.env.CLAUDE_CODE_EFFORT_LEVEL = originalEffort
}

console.log('claude-effort.test.ts passed')
