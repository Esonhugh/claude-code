#!/usr/bin/env node
import assert from 'node:assert/strict'

import {
  getDefaultEffortForModel,
  getEffortValueDescription,
  getSavedEffort,
  isEffortLevel,
  parseEffortValue,
  savedEffortPatch,
  toPersistableEffort,
} from './effort.js'
import { setIsInteractive } from '../bootstrap/state.js'

// Official 2.1.318 keeps effort per model; the top-level value is not read.
assert.equal(
  getSavedEffort({ effortLevel: 'low', modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' } } }, 'claude-opus-5-5[1m]'),
  'xhigh',
)
assert.equal(getSavedEffort({ effortLevel: 'low', modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' } } }, 'claude-fable-5-1'), undefined)
assert.equal(getSavedEffort({ modelSettings: { 'claude-fable-5-1': { autoCompactWindow: 'auto' } } }, 'claude-fable-5-1'), undefined)
assert.deepEqual(savedEffortPatch('high', 'claude-fable-5-1[1m]'), {
  modelSettings: { 'claude-fable-5-1': { effortLevel: 'high' } },
})

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
setIsInteractive(true)
assert.equal(getDefaultEffortForModel('claude-opus-5-5'), 'medium')
assert.equal(getDefaultEffortForModel('claude-fable-5-1'), 'high')
assert.equal(getDefaultEffortForModel('claude-fable-5'), 'high')
assert.equal(getDefaultEffortForModel('claude-mythos-5-1'), 'high')
assert.equal(getDefaultEffortForModel('claude-mythos-5'), 'high')
assert.equal(getDefaultEffortForModel('claude-mythos-preview'), 'high')
assert.equal(getDefaultEffortForModel('claude-sonnet-5-5'), 'medium')
assert.equal(getDefaultEffortForModel('claude-haiku-5-5'), 'medium')

// Headless runs (-p, SDK) default to high on effort-capable models.
setIsInteractive(false)
assert.equal(getDefaultEffortForModel('claude-sonnet-5-5'), 'high')
assert.equal(getDefaultEffortForModel('claude-opus-5-5'), 'high')
assert.equal(getDefaultEffortForModel('claude-3-5-haiku'), undefined)
setIsInteractive(true)

console.log('effort.test.ts passed')
