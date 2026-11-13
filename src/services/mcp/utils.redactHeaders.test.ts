import { expect, test } from 'bun:test'
import { redactHeadersForLogging } from './utils.js'

test('debug logs keep header names but hide every value except User-Agent', () => {
  expect(
    redactHeadersForLogging({
      'User-Agent': 'claude-code/test',
      Authorization: 'Bearer secret-a',
      'Some-Gateway-Token': 'secret-b',
      'x-api-key': 'secret-c',
    }),
  ).toEqual({
    'User-Agent': 'claude-code/test',
    Authorization: '[REDACTED]',
    'Some-Gateway-Token': '[REDACTED]',
    'x-api-key': '[REDACTED]',
  })
})
