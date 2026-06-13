import assert from 'node:assert/strict'

import { buildSpinnerAnimationLine } from './spinnerAnimationLine.js'

const columns = 48
const message = 'Working on a very long operation…'

const longLine = buildSpinnerAnimationLine({
  columns,
  message,
  statusText: '(thought for 12s · 1m 5s · ↓ 12,345 tokens)',
})

const shortLine = buildSpinnerAnimationLine({
  columns,
  message,
  statusText: '(1s)',
})

assert.equal(longLine.length, columns)
assert.equal(shortLine.length, columns)
assert.ok(longLine.endsWith('tokens)'))
assert.ok(shortLine.endsWith(' '.repeat(columns - shortLine.trimEnd().length)))
assert.equal(shortLine.includes('tokens)'), false)

console.log('SpinnerAnimationRow.test.ts passed')
