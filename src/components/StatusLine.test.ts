import assert from 'node:assert/strict'

import { buildStatusLineCommandInput } from './StatusLine.js'

const activeInput = buildStatusLineCommandInput(
  'default',
  false,
  {},
  [],
  [],
  'claude-sonnet-4-6',
  { active: true },
)

assert.deepEqual(activeInput.goal, { active: true })

const clearedInput = buildStatusLineCommandInput(
  'default',
  false,
  {},
  [],
  [],
  'claude-sonnet-4-6',
  { active: false },
)

assert.deepEqual(clearedInput.goal, { active: false })

console.log('StatusLine.test.ts passed')
