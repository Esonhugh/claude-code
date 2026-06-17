import assert from 'node:assert/strict'
import test from 'node:test'
import { formatUsageLoadError } from './Usage.js'

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
