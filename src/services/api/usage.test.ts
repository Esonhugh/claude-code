import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const originalFetch = globalThis.fetch
const originalOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
const originalOpenAIAuthToken = process.env.OPENAI_AUTH_TOKEN
const originalOpenAIApiKey = process.env.OPENAI_API_KEY
const originalHome = process.env.HOME
const authModule = await import('../../utils/auth.js')
const axios = (await import('axios')).default
const {
  consumeRateLimitResetCredit,
  fetchUtilization,
  prefetchChatGPTUtilization,
} = await import('./usage.js')

test('consumeRateLimitResetCredit posts ChatGPT reset credit consume request', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  authModule.getOpenAIAuthInfo.cache.set(undefined, {
    accessToken: 'test-token',
    accountId: 'account-123',
    isChatGPT: true,
  })
  authModule.getChatGPTOAuthInfo.cache.set(undefined, {
    accessToken: 'test-token',
    accountId: 'account-123',
    isChatGPT: true,
  })

  const originalAxiosPost = axios.post
  const requests: Array<{
    url: string
    body: { redeem_request_id?: string }
    headers: Record<string, string>
  }> = []
  axios.post = (async (
    url: string,
    body: { redeem_request_id?: string },
    options: { headers: Record<string, string> },
  ) => {
    requests.push({ url, body, headers: options.headers })
    return { data: {} }
  }) as typeof axios.post

  try {
    await consumeRateLimitResetCredit()

    assert.equal(
      requests[0]?.url,
      'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume',
    )
    assert.equal(typeof requests[0]?.body.redeem_request_id, 'string')
    assert.equal(requests[0]?.headers.Authorization, 'Bearer test-token')
    assert.equal(requests[0]?.headers['chatgpt-account-id'], 'account-123')
  } finally {
    axios.post = originalAxiosPost
    authModule.getOpenAIAuthInfo.cache.clear?.()
    authModule.getChatGPTOAuthInfo.cache.clear?.()
    if (originalOpenAI === undefined) {
      delete process.env.CLAUDE_CODE_USE_OPENAI
    } else {
      process.env.CLAUDE_CODE_USE_OPENAI = originalOpenAI
    }
  }
})

test('prefetchChatGPTUtilization ignores ChatGPT auth outside the OpenAI provider', async () => {
  delete process.env.CLAUDE_CODE_USE_OPENAI
  authModule.getOpenAIAuthInfo.cache.set(undefined, {
    accessToken: 'test-token',
    accountId: 'account-123',
    isChatGPT: true,
  })

  const originalAxiosGet = axios.get
  let requestCount = 0
  axios.get = (async () => {
    requestCount += 1
    return { data: { plan_type: 'pro' } }
  }) as typeof axios.get

  try {
    await prefetchChatGPTUtilization()
    assert.equal(requestCount, 0)
  } finally {
    axios.get = originalAxiosGet
    authModule.getOpenAIAuthInfo.cache.clear?.()
    if (originalOpenAI === undefined) {
      delete process.env.CLAUDE_CODE_USE_OPENAI
    } else {
      process.env.CLAUDE_CODE_USE_OPENAI = originalOpenAI
    }
  }
})

test('fetchUtilization does not show ChatGPT usage when OpenAI API key is active', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'usage-openai-api-'))
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_API_KEY = 'dummy-api-key'
  process.env.HOME = homeDir
  delete process.env.OPENAI_AUTH_TOKEN
  authModule.getOpenAIAuthInfo.cache.clear?.()
  authModule.getChatGPTOAuthInfo.cache.set(undefined, {
    accessToken: 'test-chatgpt-token',
    accountId: 'account-123',
    isChatGPT: true,
  })

  const originalAxiosGet = axios.get
  let requestCount = 0
  axios.get = (async () => {
    requestCount += 1
    return { data: { plan_type: 'pro' } }
  }) as typeof axios.get

  try {
    assert.equal(await fetchUtilization(), null)
    assert.equal(requestCount, 0)
  } finally {
    axios.get = originalAxiosGet
    authModule.getOpenAIAuthInfo.cache.clear?.()
    authModule.getChatGPTOAuthInfo.cache.clear?.()
    if (originalOpenAI === undefined) {
      delete process.env.CLAUDE_CODE_USE_OPENAI
    } else {
      process.env.CLAUDE_CODE_USE_OPENAI = originalOpenAI
    }
    if (originalOpenAIAuthToken === undefined) {
      delete process.env.OPENAI_AUTH_TOKEN
    } else {
      process.env.OPENAI_AUTH_TOKEN = originalOpenAIAuthToken
    }
    if (originalOpenAIApiKey === undefined) {
      delete process.env.OPENAI_API_KEY
    } else {
      process.env.OPENAI_API_KEY = originalOpenAIApiKey
    }
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
    await rm(homeDir, { recursive: true, force: true })
  }
})

test('fetchUtilization maps ChatGPT Codex usage when OpenAI ChatGPT auth is active', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  authModule.getOpenAIAuthInfo.cache.set(undefined, {
    accessToken: 'test-token',
    accountId: 'account-123',
    isChatGPT: true,
  })
  authModule.getChatGPTOAuthInfo.cache.set(undefined, {
    accessToken: 'test-token',
    accountId: 'account-123',
    isChatGPT: true,
  })

  const originalAxiosGet = axios.get
  const requests: Array<{ url: string; headers: Record<string, string> }> = []
  axios.get = (async (url: string, options: { headers: Record<string, string> }) => {
    requests.push({ url, headers: options.headers })
    return {
      data: {
        plan_type: 'plus',
        rate_limit: {
          primary_window: {
            used_percent: 45,
            limit_window_seconds: 7 * 24 * 60 * 60,
            reset_at: 1783684808,
          },
          secondary_window: {
            used_percent: 20,
            limit_window_seconds: 5 * 60 * 60,
            reset_at: 1783688408,
          },
        },
        credits: {
          has_credits: false,
          unlimited: false,
          balance: null,
          overage_limit_reached: false,
        },
        spend_control: {
          individual_limit: {
            limit: '100',
            used: '42',
            remaining: '58',
            used_percent: 42,
            reset_at: 1785542400,
          },
        },
        rate_limit_reset_credits: { available_count: 3 },
        additional_rate_limits: [
          {
            limit_name: 'Code Review',
            metered_feature: 'codex-auto-review',
            rate_limit: {
              primary_window: {
                used_percent: 10,
                limit_window_seconds: 30 * 24 * 60 * 60,
                reset_at: 1785542400,
              },
            },
          },
        ],
      },
    }
  }) as typeof axios.get

  try {
    const utilization = await fetchUtilization()

    assert.deepEqual(requests, [
      {
        url: 'https://chatgpt.com/backend-api/wham/usage',
        headers: {
          Authorization: 'Bearer test-token',
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': requests[0]!.headers['User-Agent'],
          Referer: 'https://chatgpt.com/',
          Origin: 'https://chatgpt.com',
          'chatgpt-account-id': 'account-123',
        },
      },
    ])
    assert.equal(utilization?.source, 'chatgpt')
    assert.equal(utilization?.plan_type, 'plus')
    assert.deepEqual(utilization?.seven_day, {
      utilization: 45,
      resets_at: '2026-07-10T12:00:08.000Z',
      window_minutes: 7 * 24 * 60,
    })
    assert.deepEqual(utilization?.seven_day_sonnet, {
      utilization: 20,
      resets_at: '2026-07-10T13:00:08.000Z',
      window_minutes: 5 * 60,
    })
    assert.deepEqual(utilization?.monthly_credit_limit, {
      limit: '100',
      used: '42',
      remaining: '58',
      utilization: 42,
      resets_at: '2026-08-01T00:00:00.000Z',
    })
    assert.equal(utilization?.rate_limit_reset_credits?.available_count, 3)
    assert.deepEqual(utilization?.chatgpt_limits, [
      {
        title: 'ChatGPT Codex weekly usage (Plus)',
        limit: {
          utilization: 45,
          resets_at: '2026-07-10T12:00:08.000Z',
          window_minutes: 7 * 24 * 60,
        },
      },
      {
        title: 'Secondary 5h usage',
        limit: {
          utilization: 20,
          resets_at: '2026-07-10T13:00:08.000Z',
          window_minutes: 5 * 60,
        },
      },
      {
        title: 'Code Review monthly usage',
        limit: {
          utilization: 10,
          resets_at: '2026-08-01T00:00:00.000Z',
          window_minutes: 30 * 24 * 60,
        },
      },
      {
        title: 'Monthly credit limit',
        limit: {
          utilization: 42,
          resets_at: '2026-08-01T00:00:00.000Z',
        },
        extraSubtext: '42 of 100 credits used',
      },
    ])
  } finally {
    axios.get = originalAxiosGet
    authModule.getOpenAIAuthInfo.cache.clear?.()
    authModule.getChatGPTOAuthInfo.cache.clear?.()
    globalThis.fetch = originalFetch
    if (originalOpenAI === undefined) {
      delete process.env.CLAUDE_CODE_USE_OPENAI
    } else {
      process.env.CLAUDE_CODE_USE_OPENAI = originalOpenAI
    }
  }
})
