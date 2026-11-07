import { afterAll, expect, spyOn, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'

const auth = await import('../../utils/auth.js')
const subscriber = spyOn(auth, 'isClaudeAISubscriber').mockReturnValue(true)
afterAll(() => subscriber.mockRestore())
const { getAssistantMessageFromError } = await import('./errors.js')

function usageLimit429(headers: Record<string, string>): APIError {
  return APIError.generate(
    429,
    { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } },
    'rate limited',
    new Headers(headers),
  )
}

test('a usage-limit 429 carries the rejected quota limits on the API error message', () => {
  const message = getAssistantMessageFromError(
    usageLimit429({
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      'anthropic-ratelimit-unified-reset': '1900000000',
    }),
    'claude-sonnet-4-5',
  )
  expect(message.isApiErrorMessage).toBe(true)
  expect(message.error).toBe('rate_limit')
  expect(message.quotaLimits).toMatchObject({
    status: 'rejected',
    resetsAt: 1900000000,
    rateLimitType: 'five_hour',
    isUsingOverage: false,
  })
})

test('a 429 without quota headers carries no quota limits', () => {
  const message = getAssistantMessageFromError(usageLimit429({}), 'claude-sonnet-4-5')
  expect(message.error).toBe('rate_limit')
  expect(message.quotaLimits).toBeUndefined()
})

test('a ChatGPT usage-limit 429 says when it resets instead of the raw body', async () => {
  const { HttpResponseError } = await import('../../utils/errors.js')
  const body = '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"plus","resets_at":1900000000,"resets_in_seconds":1800}}'
  const message = getAssistantMessageFromError(
    new HttpResponseError(429, `OpenAI API 429: ${body}`, new Headers()),
    'gpt-6.1-sol',
  )
  expect(message.error).toBe('rate_limit')
  const text = (message.message.content[0] as { text: string }).text
  expect(text).toMatch(/^You've hit your ChatGPT usage limit · resets /)
  expect(text).not.toContain('usage_limit_reached')
})
