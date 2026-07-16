#!/usr/bin/env node
import assert from 'node:assert/strict'

import { executeEffort, showCurrentEffort } from './effort.js'
import { getEffortValueDescription, isEffortLevel } from '../../utils/effort.js'

assert.equal(isEffortLevel('xhigh'), true)
assert.equal(isEffortLevel('ultracode'), true)
assert.equal(
  getEffortValueDescription('xhigh'),
  'Extended capability for long-horizon work',
)
assert.equal(
  getEffortValueDescription('ultracode'),
  'xhigh + dynamic workflow orchestration',
)

const xhighResult = executeEffort('xhigh')
assert.equal(
  xhighResult.message,
  'Set effort level to xhigh: Extended capability for long-horizon work',
)
assert.deepEqual(xhighResult.effortUpdate, { value: 'xhigh' })

const result = executeEffort('ultracode')
assert.equal(
  result.message,
  'Set effort level to ultracode: xhigh + dynamic workflow orchestration',
)
assert.deepEqual(result.effortUpdate, { value: 'ultracode' })

assert.equal(
  showCurrentEffort('ultracode', 'claude-opus-4-7').message,
  'Current effort level: ultracode → xhigh (xhigh + dynamic workflow orchestration)',
)

assert.match(
  executeEffort('invalid').message,
  /Valid options are: none, low, medium, high, xhigh, max, ultra, ultracode, auto/,
)

const originalUseOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
delete process.env.CLAUDE_CODE_USE_OPENAI
assert.equal(
  showCurrentEffort('ultra', 'claude-opus-4-6').message,
  'Current effort level: ultra → max (Ultra effort, sent as max on Anthropic)',
)
if (originalUseOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
else process.env.CLAUDE_CODE_USE_OPENAI = originalUseOpenAI

console.log('effort.test.ts passed')
