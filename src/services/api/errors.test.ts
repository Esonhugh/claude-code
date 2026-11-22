import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import { setIsInteractive } from '../../bootstrap/state.js'
import { categorizeRetryableAPIError, getAssistantMessageFromError, getErrorMessageIfRefusal } from './errors.js'

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

test('an error sent down the stream shows its own message, not the event JSON (official 2.1.329)', () => {
  const body = { type: 'error', error: { type: 'api_error', message: 'fake mid-stream error' } }
  const message = getAssistantMessageFromError(
    new APIError(undefined, body, undefined, new Headers()),
    'claude-opus-5-5',
  )
  expect(message.error).toBe('unknown')
  expect((message.message.content as Array<{ text: string }>)[0]!.text).toBe('API Error: fake mid-stream error')
})

test('a 404 is reported as model_not_found (official 2.1.329)', () => {
  const message = getAssistantMessageFromError(apiError(404, 'not_found_error', 'model: claude-opus-5-5'), 'claude-opus-5-5')
  expect(message.error).toBe('model_not_found')
})

test('a connection lost mid-response names its code (official 2.1.329)', () => {
  const cut = Object.assign(new Error('The socket connection was closed unexpectedly'), { code: 'ECONNRESET' })
  const message = getAssistantMessageFromError(cut, 'claude-opus-5-5')
  expect(message.error).toBe('server_error')
  expect((message.message.content as Array<{ text: string }>)[0]!.text).toBe(
    'API Error: Connection to the API was lost (ECONNRESET). This is usually temporary — try again.',
  )
  const other = getAssistantMessageFromError(Object.assign(new Error('boom'), { code: 'EOTHER' }), 'claude-opus-5-5')
  expect(other.error).toBe('unknown')
  expect((other.message.content as Array<{ text: string }>)[0]!.text).toBe('API Error: boom')
})

test('api_retry calls a 529 overloaded, and a 429 rate_limit (official 2.1.329)', () => {
  expect(categorizeRetryableAPIError(apiError(529, 'overloaded_error', 'Overloaded'))).toBe('overloaded')
  expect(categorizeRetryableAPIError(apiError(429, 'rate_limit_error', 'slow down'))).toBe('rate_limit')
})

describe('an API error message carries the type and code of the error body (official 2.1.329)', () => {
  test('the error type is reported as it is', () => {
    const message = getAssistantMessageFromError(apiError(400, 'invalid_request_error', 'fake 400'), 'claude-opus-5-5')
    expect(message).toMatchObject({ apiErrorStatus: 400, apiErrorType: 'invalid_request_error' })
    expect(message.apiErrorCode).toBeUndefined()
  })

  test('a type that is not an identifier is left out', () => {
    const message = getAssistantMessageFromError(apiError(400, 'Not An Identifier', 'fake 400'), 'claude-opus-5-5')
    expect(message.apiErrorType).toBeUndefined()
  })

  test('details.error_code is reported, and a DLP denial has no type', () => {
    const error = (code: string) => APIError.generate(
      400,
      { type: 'error', error: { type: 'invalid_request_error', message: 'x', details: { error_code: code } } },
      undefined,
      new Headers(),
    )
    expect(getAssistantMessageFromError(error('some_code'), 'claude-opus-5-5')).toMatchObject({
      apiErrorCode: 'some_code',
      apiErrorType: 'invalid_request_error',
    })
    const denied = getAssistantMessageFromError(error('dlp_request_denied'), 'claude-opus-5-5')
    expect(denied.apiErrorCode).toBe('dlp_request_denied')
    expect(denied.apiErrorType).toBeUndefined()
  })
})

describe('the error a refused response ends with (official 2.1.329)', () => {
  const textOf = (model: string, details?: { category?: string; explanation?: string }, requestId?: string) => {
    const message = getErrorMessageIfRefusal('refusal', model, 'msg_1', details, requestId)!
    const block = message.message.content[0]
    return { message, text: block?.type === 'text' ? block.text : undefined }
  }
  beforeEach(() => setIsInteractive(false))

  test('a model official routes refusals away from gets the long wording', () => {
    const { message, text } = textOf('claude-opus-5-5')
    expect(text).toBe(
      "API Error: Opus 5.5's safeguards flagged this message (https://www.anthropic.com/legal/aup). This sometimes happens with safe, normal conversations. Claude Code can't respond to this message with Opus 5.5.\n\n" +
      'Try rephrasing the request in a new session or change your model.\n\n' +
      'Learn more: https://support.claude.com/en/articles/8106465\n\n' +
      'Message ID: msg_1',
    )
    expect(message).toMatchObject({ refusedMessageId: 'msg_1', refusingModel: 'claude-opus-5-5', isApiErrorMessage: true })
    expect(message.message).toMatchObject({ stop_reason: 'refusal', stop_details: null })
  })

  test('other models get the short wording', () => {
    expect(textOf('claude-opus-4-8').text).toBe(
      "API Error: Opus 4.8 can't help with this. Start a new session to continue.\n\n" +
      'Learn more: https://www.anthropic.com/legal/aup\n\n' +
      'Message ID: msg_1',
    )
  })

  test('a cyber refusal names its category, and the request id comes before the message id', () => {
    const details = { type: 'refusal', category: 'cyber', explanation: 'fake refusal' }
    const { message, text } = textOf('claude-sonnet-5-5', details, 'req_1')
    expect(text).toBe(
      "API Error: Sonnet 5.5's safeguards flagged this message. Our intentionally broad safeguards allow us to deliver more capabilities faster, but can sometimes flag legitimate cybersecurity work. Learn more: https://support.claude.com/en/articles/14604842-real-time-cyber-safeguards-on-claude\n\n" +
      'Details: `[cyber]`\n\n' +
      'Request ID: req_1\n\n' +
      'Message ID: msg_1',
    )
    expect(message.message.stop_details).toEqual(details)
    expect(message.requestId).toBe('req_1')
  })

  test('nothing is produced for another stop reason', () => {
    expect(getErrorMessageIfRefusal('end_turn', 'claude-opus-5-5')).toBeUndefined()
  })
})
