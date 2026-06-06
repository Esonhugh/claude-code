#!/usr/bin/env node
import assert from 'node:assert/strict'

import {
  getEffortValueDescription,
  isEffortLevel,
  parseEffortValue,
  toPersistableEffort,
} from './effort.js'

assert.equal(isEffortLevel('ultracode'), true)
assert.equal(parseEffortValue('ultracode'), 'ultracode')
assert.equal(toPersistableEffort('ultracode'), undefined)
assert.equal(
  getEffortValueDescription('ultracode'),
  'xhigh + dynamic workflow orchestration',
)

console.log('effort.test.ts passed')
