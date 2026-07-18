#!/usr/bin/env bun
import assert from 'node:assert/strict'

import terminal from './index.js'

assert.equal(terminal.type, 'local-jsx')
assert.equal(terminal.name, 'terminal')
assert.equal(
  terminal.description,
  'View terminal sessions',
)

console.log('terminal.test.ts passed')
