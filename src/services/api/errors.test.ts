import { expect, test } from 'bun:test'
import { getAssistantMessageFromError } from './errors.js'

test('a missing AWS credential is reported like official', () => {
  const error = Object.assign(
    new Error('Could not load credentials from any providers'),
    { name: 'CredentialsProviderError' },
  )
  const message = getAssistantMessageFromError(error, 'claude-sonnet-4-5')
  expect(message.error).toBe('authentication_failed')
  expect(message.message.content).toEqual([
    expect.objectContaining({
      text: 'API Error: Could not load AWS credentials · Could not load credentials from any providers. Check or refresh your AWS credentials and try again.',
    }),
  ])
})
