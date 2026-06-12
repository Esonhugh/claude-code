#!/usr/bin/env bun
import assert from 'node:assert/strict'

import interactiveTerminal from './index.js'

assert.equal(interactiveTerminal.type, 'local-jsx')
assert.equal(interactiveTerminal.name, 'interactive-terminal')
assert.equal(
  interactiveTerminal.description,
  'View interactive terminal sessions',
)

console.log('interactive-terminal.test.ts passed')
