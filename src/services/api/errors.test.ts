import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import { setIsInteractive } from '../../bootstrap/state.js'
import { categorizeRetryableAPIError, getAssistantMessageFromError } from './errors.js'

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

function apiError(status: number, type: string, message: string): APIError {
  return APIError.generate(
    status,
    { type: 'error', error: { type, message }, request_id: 'req_test' },
    undefined,
    new Headers(),
  )
}

describe('API error text names the message, not the JSON body (official 2.1.329)', () => {
  let previousBaseUrl: string | undefined
  beforeEach(() => {
    previousBaseUrl = process.env.ANTHROPIC_BASE_URL
    setIsInteractive(false)
  })
  afterEach(() => {
    if (previousBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = previousBaseUrl
  })
  const textOf = (error: unknown) => {
    const block = getAssistantMessageFromError(error, 'claude-opus-5-5').message.content[0]
    return block?.type === 'text' ? block.text : undefined
  }

  test('a 400 shows the API message', () => {
    expect(textOf(apiError(400, 'invalid_request_error', 'fake 400'))).toBe('API Error: 400 fake 400')
  })

  test.each([401, 403])('a %d shows the API message after the authentication prefix', status => {
    expect(textOf(apiError(status, 'permission_error', 'Request not allowed'))).toBe(
      `Failed to authenticate. API Error: ${status} Request not allowed`,
    )
  })

  test('a 429 without subscription limits is a rejected request with the API message', () => {
    const message = getAssistantMessageFromError(apiError(429, 'rate_limit_error', 'fake 429'), 'claude-opus-5-5')
    expect(message.error).toBe('rate_limit')
    expect(textOf(apiError(429, 'rate_limit_error', 'fake 429'))).toBe('API Error: Request rejected (429) · fake 429')
  })

  test('a 5xx is called a server-side issue and points at the gateway', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:38912/s/x'
    const message = getAssistantMessageFromError(apiError(500, 'api_error', 'Internal server error.'), 'claude-opus-5-5')
    expect(message.error).toBe('server_error')
    expect(textOf(apiError(500, 'api_error', 'Internal server error.'))).toBe(
      'API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway (127.0.0.1:38912).',
    )
  })
})

test('api_retry calls a 529 overloaded, and a 429 rate_limit (official 2.1.329)', () => {
  expect(categorizeRetryableAPIError(apiError(529, 'overloaded_error', 'Overloaded'))).toBe('overloaded')
  expect(categorizeRetryableAPIError(apiError(429, 'rate_limit_error', 'slow down'))).toBe('rate_limit')
})
