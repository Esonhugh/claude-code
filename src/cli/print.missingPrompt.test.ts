import { expect, test } from 'bun:test'
import { getMissingPromptError } from './print.js'

// Official 2.1.311 -p input checks: empty prompt errors even with --resume/--continue.
test('empty -p prompts error like official 2.1.311', () => {
  expect(getMissingPromptError('', {})).toStartWith('Error: Input must be provided either through stdin')
  expect(getMissingPromptError('  ', {})).toStartWith('Error: Input contained only whitespace.')
  expect(getMissingPromptError('', { resume: '550e8400-e29b-41d4-a716-446655440000' })).toStartWith('Error: No deferred tool marker found in the resumed session.')
  expect(getMissingPromptError('', { continue: true })).toStartWith('Error: No deferred tool marker found')
  expect(getMissingPromptError('', { resume: true })).toStartWith('Error: Input must be provided')
  expect(getMissingPromptError('', { sdkUrl: 'wss://x' })).toBeNull()
  expect(getMissingPromptError('hi', { resume: 'x' })).toBeNull()
})
