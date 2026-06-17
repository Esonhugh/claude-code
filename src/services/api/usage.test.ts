import assert from 'node:assert/strict'
import test from 'node:test'

globalThis.MACRO = { VERSION: 'test' }

const originalFetch = globalThis.fetch
const originalOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
const authModule = await import('../../utils/auth.js')
const axios = (await import('axios')).default
const { fetchUtilization } = await import('./usage.js')

test('fetchUtilization maps ChatGPT Codex usage when OpenAI ChatGPT auth is active', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  authModule.getOpenAIAuthInfo.cache.set(undefined, {
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
            reset_at: 1783684808,
          },
          secondary_window: null,
        },
        credits: {
          has_credits: false,
          unlimited: false,
          balance: null,
          overage_limit_reached: false,
        },
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
    })
  } finally {
    axios.get = originalAxiosGet
    authModule.getOpenAIAuthInfo.cache.clear?.()
    globalThis.fetch = originalFetch
    if (originalOpenAI === undefined) {
      delete process.env.CLAUDE_CODE_USE_OPENAI
    } else {
      process.env.CLAUDE_CODE_USE_OPENAI = originalOpenAI
    }
  }
})
