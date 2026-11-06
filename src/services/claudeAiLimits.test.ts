import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, spyOn, test } from 'bun:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}
const home = mkdtempSync(join(tmpdir(), 'claude-ai-limits-'))
process.env.HOME = home
process.env.CLAUDE_CONFIG_DIR = join(home, '.claude')
process.env.ANTHROPIC_API_KEY = 'test-key'

const auth = await import('../utils/auth.js')
const subscriber = spyOn(auth, 'isClaudeAISubscriber').mockReturnValue(true)
const {
  extractQuotaStatusFromHeaders,
  getRateLimitDisplayName,
  getRawUtilization,
} = await import('./claudeAiLimits.js')
const { getRateLimitMessage } = await import('./rateLimitMessages.js')

afterAll(() => {
  subscriber.mockRestore()
})

test('the overage-included weekly window is read from the 7d_oi headers', () => {
  extractQuotaStatusFromHeaders(
    new Headers({
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.12',
      'anthropic-ratelimit-unified-5h-reset': '1760000000',
      'anthropic-ratelimit-unified-7d-utilization': '0.4',
      'anthropic-ratelimit-unified-7d-reset': '1760500000',
      'anthropic-ratelimit-unified-7d_oi-utilization': '0.375',
      'anthropic-ratelimit-unified-7d_oi-reset': '1760500000',
    }),
  )

  expect(getRawUtilization()).toEqual({
    five_hour: { utilization: 0.12, resets_at: 1760000000 },
    seven_day: { utilization: 0.4, resets_at: 1760500000 },
    seven_day_overage_included: { utilization: 0.375, resets_at: 1760500000 },
  })
})

test('a ChatGPT sign-in reads its 5-hour and weekly windows from the Codex headers (#947)', () => {
  const prior = process.env.CLAUDE_CODE_USE_OPENAI
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  const chatgpt = spyOn(auth, 'getOpenAIAuthInfo').mockReturnValue({ accessToken: 't', isChatGPT: true })
  try {
    extractQuotaStatusFromHeaders(
      new Headers({
        'x-codex-primary-used-percent': '34',
        'x-codex-primary-reset-at': '1794006268',
        'x-codex-primary-window-minutes': '300',
        'x-codex-secondary-used-percent': '12.5',
        'x-codex-secondary-reset-at': '1794448581',
        'x-codex-secondary-window-minutes': '10080',
      }),
    )
    expect(getRawUtilization()).toEqual({
      five_hour: { utilization: 0.34, resets_at: 1794006268 },
      seven_day: { utilization: 0.125, resets_at: 1794448581 },
    })
    // A response without the headers keeps the last reading.
    extractQuotaStatusFromHeaders(new Headers())
    expect(getRawUtilization().five_hour?.utilization).toBe(0.34)
  } finally {
    chatgpt.mockRestore()
    if (prior === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
    else process.env.CLAUDE_CODE_USE_OPENAI = prior
  }
})

test('the overage-included weekly limit is named after Fable', () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 6 * 24 * 3600
  expect(getRateLimitDisplayName('seven_day_overage_included')).toBe('Fable limit')
  expect(
    getRateLimitMessage(
      {
        status: 'rejected',
        unifiedRateLimitFallbackAvailable: false,
        isUsingOverage: false,
        rateLimitType: 'seven_day_overage_included',
        resetsAt,
      },
      'claude-fable-5-1',
    ),
  ).toEqual({
    severity: 'error',
    message: expect.stringMatching(/^You've hit your Fable limit · resets /),
  })
  expect(
    getRateLimitMessage(
      {
        status: 'allowed_warning',
        unifiedRateLimitFallbackAvailable: false,
        isUsingOverage: false,
        rateLimitType: 'seven_day_overage_included',
        utilization: 0.8,
        resetsAt,
      },
      'claude-fable-5-1',
    ),
  ).toEqual({
    severity: 'warning',
    message: expect.stringMatching(/^You've used 80% of your Fable limit · resets /),
  })
})
