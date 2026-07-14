#!/usr/bin/env node
import assert from 'node:assert/strict'

import { executeEffort, showCurrentEffort } from './effort.js'
import { getEffortValueDescription, isEffortLevel } from '../../utils/effort.js'

assert.equal(isEffortLevel('xhigh'), true)
assert.equal(isEffortLevel('ultracode'), true)
assert.equal(getEffortValueDescription('xhigh'), 'Deepest OpenAI reasoning')
assert.equal(
  getEffortValueDescription('ultracode'),
  'xhigh + dynamic workflow orchestration',
)

const xhighResult = executeEffort('xhigh')
assert.equal(
  xhighResult.message,
  'Set effort level to xhigh (this session only): Deepest OpenAI reasoning',
)
assert.deepEqual(xhighResult.effortUpdate, { value: 'xhigh' })

const result = executeEffort('ultracode')
assert.equal(
  result.message,
  'Set effort level to ultracode (this session only): xhigh + dynamic workflow orchestration',
)
assert.deepEqual(result.effortUpdate, { value: 'ultracode' })

assert.equal(
  showCurrentEffort('ultracode', 'claude-opus-4-7').message,
  'Current effort level: ultracode → xhigh (xhigh + dynamic workflow orchestration; this session only)',
)

assert.match(
  executeEffort('invalid').message,
  /Valid options are: none, low, medium, high, xhigh, max, ultra, ultracode, auto/,
)

assert.equal(
  showCurrentEffort('ultra', 'claude-opus-4-6').message,
  'Current effort level: ultra → xhigh (Codex ultra reasoning, sent as xhigh effort; this session only)',
)

console.log('effort.test.ts passed')
