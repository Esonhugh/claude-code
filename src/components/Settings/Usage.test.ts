import assert from 'node:assert/strict'
import test from 'node:test'
import { buildOpenAIProperties } from './Status.js'
import {
  formatOpenAIAccountLine,
  formatResetRowLabel,
  formatUsageLoadError,
} from './Usage.js'

test('formatUsageLoadError includes axios response status and body', () => {
  const message = formatUsageLoadError({
    response: {
      status: 401,
      statusText: 'Unauthorized',
      data: { error: 'token expired' },
    },
  })

  assert.equal(
    message,
    'Failed to load usage data: HTTP 401 Unauthorized {"error":"token expired"}',
  )
})

test('formatUsageLoadError includes axios network message without response', () => {
  const message = formatUsageLoadError(new Error('timeout of 5000ms exceeded'))

  assert.equal(
    message,
    'Failed to load usage data: timeout of 5000ms exceeded',
  )
})

test('formatResetRowLabel shows reset button only when count is positive', () => {
  assert.equal(formatResetRowLabel(1), 'Reset: 1            [Reset]')
  assert.equal(formatResetRowLabel(0), 'Reset: 0')
})

test('formatOpenAIAccountLine includes name and email when both are present', () => {
  assert.equal(
    formatOpenAIAccountLine({ name: 'Alice', email: 'alice@example.com' }),
    'Openai Account Name: Alice (alice@example.com)',
  )
})

test('buildOpenAIProperties includes account line only', () => {
  assert.deepEqual(
    buildOpenAIProperties({
      openai_account: { name: 'Alice', email: 'alice@example.com' },
      plan_type: 'plus',
    }),
    [
      { label: 'OpenAI Account', value: 'Alice (alice@example.com)' },
    ],
  )
})
