#!/usr/bin/env node
import assert from 'node:assert/strict'

import {
  getDefaultEffortForModel,
  getEffortValueDescription,
  isEffortLevel,
  parseEffortValue,
  toPersistableEffort,
} from './effort.js'

assert.equal(isEffortLevel('minimal'), true)
assert.equal(parseEffortValue('minimal'), 'minimal')
assert.equal(toPersistableEffort('minimal'), 'minimal')
assert.equal(getEffortValueDescription('minimal'), 'Minimal reasoning effort')
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
assert.equal(getDefaultEffortForModel('claude-opus-5-5'), 'medium')
assert.equal(getDefaultEffortForModel('claude-fable-5-1'), 'high')
assert.equal(getDefaultEffortForModel('claude-fable-5'), 'high')
assert.equal(getDefaultEffortForModel('claude-mythos-5-1'), 'high')
assert.equal(getDefaultEffortForModel('claude-mythos-5'), 'high')
assert.equal(getDefaultEffortForModel('claude-mythos-preview'), 'high')
assert.equal(getDefaultEffortForModel('claude-sonnet-5-5'), 'high')

console.log('effort.test.ts passed')
