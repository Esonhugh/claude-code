#!/usr/bin/env node
import assert from 'node:assert/strict'

import {
  getEffortValueDescription,
  isEffortLevel,
  parseEffortValue,
  toPersistableEffort,
} from './effort.js'

assert.equal(isEffortLevel('xhigh'), true)
assert.equal(parseEffortValue('xhigh'), 'xhigh')
assert.equal(isEffortLevel('ultracode'), true)
assert.equal(parseEffortValue('ultracode'), 'ultracode')
assert.equal(toPersistableEffort('xhigh'), 'xhigh')
assert.equal(toPersistableEffort('max'), 'max')
assert.equal(toPersistableEffort('ultra'), 'ultra')
assert.equal(toPersistableEffort('ultracode'), 'ultracode')
assert.equal(getEffortValueDescription('none'), 'No reasoning for latency-critical OpenAI tasks')
assert.equal(
  getEffortValueDescription('ultracode'),
  'xhigh + dynamic workflow orchestration',
)

console.log('effort.test.ts passed')
