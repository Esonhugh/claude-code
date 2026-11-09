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

test.each([
  ['OpenAI Responses HTTP 400', 'OpenAI API 400: {"error":{"message":"Your input exceeds the context window of this model. Please adjust your input and try again.","type":"invalid_request_error","param":"input","code":"context_length_exceeded"}}'],
  ['OpenAI Responses response.failed', 'Your input exceeds the context window of this model. Please adjust your input and try again.'],
  ['vLLM / OpenRouter', "OpenAI API 400: {\"error\":{\"message\":\"This model's maximum context length is 32768 tokens. However, you requested 40000 tokens.\"}}"],
  ['xAI', "OpenAI API 400: {\"error\":\"This model's maximum prompt length is 131072 but the request contains 140000 tokens.\"}"],
])('a context overflow from %s is a prompt-too-long error', (_name, text) => {
  const message = getAssistantMessageFromError(new Error(text), 'gpt-5.5')
  expect(message.message.content).toEqual([expect.objectContaining({ text: 'Prompt is too long' })])
  expect(message.errorDetails).toBe(text)
})
