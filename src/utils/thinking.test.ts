#!/usr/bin/env node
import assert from 'node:assert/strict'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const { modelSupportsAdaptiveThinking, modelSupportsThinking } = await import('./thinking.js')

for (const model of [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-fable-5',
  'claude-mythos-5',
]) {
  assert.equal(
    modelSupportsAdaptiveThinking(model),
    true,
    `${model} should support adaptive thinking`,
  )
}

for (const model of [
  'claude-3-5-sonnet',
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
]) {
  assert.equal(
    modelSupportsAdaptiveThinking(model),
    false,
    `${model} should not support adaptive thinking`,
  )
}

for (const provider of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) {
  process.env[provider] = '1'
  try {
    for (const model of ['claude-opus-5', 'claude-sonnet-5']) {
      assert.equal(modelSupportsThinking(model), true)
      assert.equal(modelSupportsAdaptiveThinking(model), true)
    }
  } finally {
    delete process.env[provider]
  }
}

console.log('thinking.test.ts passed')
