#!/usr/bin/env node
import assert from 'node:assert/strict'

import { executeEffort, showCurrentEffort } from './effort.js'
import { getEffortValueDescription, isEffortLevel } from '../../utils/effort.js'

assert.equal(isEffortLevel('ultracode'), true)
assert.equal(
  getEffortValueDescription('ultracode'),
  'xhigh + dynamic workflow orchestration',
)

const result = executeEffort('ultracode')
assert.equal(
  result.message,
  'Set effort level to ultracode (this session only): xhigh + dynamic workflow orchestration',
)
assert.deepEqual(result.effortUpdate, { value: 'ultracode' })

assert.equal(
  showCurrentEffort('ultracode', 'claude-opus-4-7').message,
  'Current effort level: ultracode (xhigh + dynamic workflow orchestration; this session only)',
)

assert.match(
  executeEffort('invalid').message,
  /Valid options are: low, medium, high, max, ultracode, auto/,
)

console.log('effort.test.ts passed')
