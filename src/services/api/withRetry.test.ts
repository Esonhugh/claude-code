import { afterEach, beforeEach, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import { HttpResponseError } from '../../utils/errors.js'
import {
  CannotRetryError,
  getDefaultMaxRetries,
  getRetryDelay,
  withRetry,
} from './withRetry.js'

const ENV_KEYS = [
  'CLAUDE_CODE_RETRY_WATCHDOG',
  'CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS',
  'CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS',
  'CLAUDE_CODE_MAX_RETRIES',
  'CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS',
  'CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS',
] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

function apiError(status: number, headers: Record<string, string> = {}) {
  return APIError.generate(
    status,
    { type: 'error', error: { type: 'rate_limit_error', message: 'x' } },
    undefined,
    new Headers(headers),
  )
}

async function run(
  fail: (attempt: number) => unknown,
  maxRetries?: number,
): Promise<{ attempts: number; result?: string; error?: unknown }> {
  let attempts = 0
  const gen = withRetry(
    async () => ({}) as never,
    async (_client, attempt) => {
      attempts = attempt
      const error = fail(attempt)
      if (error) throw error
      return 'ok'
    },
    {
      model: 'claude-sonnet-4-6',
      thinkingConfig: { type: 'disabled' },
      querySource: 'sdk',
      ...(maxRetries !== undefined && { maxRetries }),
    },
  )
  try {
    let step = await gen.next()
    while (!step.done) step = await gen.next()
    return { attempts, result: step.value }
  } catch (error) {
    return { attempts, error }
  }
}

test('CLAUDE_CODE_MAX_RETRIES is capped at 15 unless the retry watchdog is on', () => {
  expect(getDefaultMaxRetries()).toBe(10)
  process.env.CLAUDE_CODE_MAX_RETRIES = '50'
  expect(getDefaultMaxRetries()).toBe(15)
  process.env.CLAUDE_CODE_MAX_RETRIES = '0'
  expect(getDefaultMaxRetries()).toBe(0)
  process.env.CLAUDE_CODE_MAX_RETRIES = 'abc'
  expect(getDefaultMaxRetries()).toBe(10)

  process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
  delete process.env.CLAUDE_CODE_MAX_RETRIES
  expect(getDefaultMaxRetries()).toBe(300)
  process.env.CLAUDE_CODE_MAX_RETRIES = '50'
  expect(getDefaultMaxRetries()).toBe(50)
})

test('overloaded backoff honors base and max delay overrides', () => {
  expect(getRetryDelay(1, null, 40_000, 20_000)).toBeGreaterThanOrEqual(20_000)
  expect(getRetryDelay(5, null, 40_000, 20_000)).toBeLessThanOrEqual(50_000)
  expect(getRetryDelay(5, null, 40_000, 20_000)).toBeGreaterThanOrEqual(40_000)
})

test('without the watchdog a 5xx stops after the retry budget', async () => {
  const { attempts, error } = await run(
    () => apiError(503, { 'retry-after': '0' }),
    2,
  )
  expect(error).toBeInstanceOf(CannotRetryError)
  expect(attempts).toBe(3)
})

test('the retry watchdog keeps retrying 429 past maxRetries', async () => {
  process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
  let calls = 0
  const { result } = await run(
    () => (++calls < 6 ? apiError(429, { 'retry-after': '0' }) : null),
    1,
  )
  expect(result).toBe('ok')
  expect(calls).toBe(6)
})

test('CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS ends capacity waits', async () => {
  process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
  process.env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS = '20'
  const started = Date.now()
  const { error } = await run(() => apiError(529), 1)
  expect(error).toBeInstanceOf(CannotRetryError)
  expect(((error as CannotRetryError).originalError as APIError).status).toBe(
    529,
  )
  expect(Date.now() - started).toBeLessThan(5_000)
})

test('CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS fails a far-away usage limit reset', async () => {
  process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
  process.env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS = '60000'
  const reset = String(Math.floor(Date.now() / 1000) + 3600)
  const { attempts, error } = await run(() =>
    apiError(429, {
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-reset': reset,
    }),
  )
  expect(error).toBeInstanceOf(CannotRetryError)
  expect(attempts).toBe(1)
})

test('the retry watchdog fails immediately on an organization spend limit', async () => {
  process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
  const { attempts, error } = await run(() =>
    apiError(429, {
      'anthropic-ratelimit-unified-overage-disabled-reason':
        'org_spend_cap_reached',
    }),
  )
  expect(error).toBeInstanceOf(CannotRetryError)
  expect(attempts).toBe(1)
})

test('OpenAI-compatible transient errors are retried and keep the original error', async () => {
  const transient = await run(
    attempt =>
      attempt < 3
        ? new HttpResponseError(
            503,
            'OpenAI API 503: upstream',
            new Headers({ 'retry-after': '0' }),
          )
        : null,
    5,
  )
  expect(transient.result).toBe('ok')
  expect(transient.attempts).toBe(3)

  const exhausted = await run(
    () =>
      new HttpResponseError(
        502,
        'OpenAI API 502: bad gateway',
        new Headers({ 'retry-after': '0' }),
      ),
    1,
  )
  expect(exhausted.attempts).toBe(2)
  const original = (exhausted.error as CannotRetryError).originalError
  expect(original).toBeInstanceOf(HttpResponseError)
  expect((original as HttpResponseError).message).toBe(
    'OpenAI API 502: bad gateway',
  )

  const quota = await run(
    () =>
      new HttpResponseError(
        429,
        'OpenAI API 429: {"error":{"type":"usage_limit_reached"}}',
        new Headers({ 'retry-after': '0' }),
      ),
    5,
  )
  expect(quota.attempts).toBe(1)
  const auth = await run(
    () => new HttpResponseError(401, 'OpenAI API 401: bad key'),
    5,
  )
  expect(auth.attempts).toBe(1)
})
