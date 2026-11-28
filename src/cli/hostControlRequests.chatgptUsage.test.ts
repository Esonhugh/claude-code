import { expect, spyOn, test } from 'bun:test'

import type { RateLimit, Utilization } from '../services/api/usage.js'
import * as usage from '../services/api/usage.js'
import { buildUsageResponse, chatGPTRateLimits } from './hostControlRequests.js'

test('ChatGPT 5h and weekly windows are not repeated as model-scoped rows', () => {
  const primary: RateLimit = { utilization: 2, resets_at: '2026-11-03T17:44:56.000Z', window_minutes: 300 }
  const secondary: RateLimit = { utilization: 94, resets_at: '2026-11-04T15:58:17.000Z', window_minutes: 10080 }
  const spark: RateLimit = { utilization: 10, resets_at: null, window_minutes: 300 }
  const utilization: Utilization = {
    source: 'chatgpt',
    seven_day: primary,
    seven_day_sonnet: secondary,
    chatgpt_limits: [
      { title: 'ChatGPT Codex 5h usage (Plus)', limit: primary },
      { title: 'Secondary weekly usage', limit: secondary },
      { title: 'Codex-Spark 5h usage', limit: spark },
    ],
  }
  expect(chatGPTRateLimits(utilization)).toEqual({
    five_hour: { utilization: 2, resets_at: '2026-11-03T17:44:56.000Z' },
    seven_day: { utilization: 94, resets_at: '2026-11-04T15:58:17.000Z' },
    model_scoped: [{ display_name: 'Codex-Spark 5h usage', utilization: 10, resets_at: null }],
  })
})


test('usage response projects only reported ChatGPT balances and reset voucher counts', async () => {
  const fetch = spyOn(usage, 'fetchUtilization')
  try {
    for (const [credits, expected] of [
      [{ balance: '123456789.0123456789', has_credits: true }, { balance: '123456789.0123456789' }],
      [{ balance: 2.5 }, { balance: 2.5 }],
      [{ balance: '0' }, { balance: '0' }],
      [{ balance: 0 }, { balance: 0 }],
      [{ unlimited: true, balance: 3 }, { unlimited: true }],
      [{ has_credits: true }, undefined],
      [{ balance: null }, undefined],
      [{ balance: '' }, undefined],
      [{ balance: '0xff' }, undefined],
      [{ balance: -1 }, undefined],
      [{ balance: Infinity }, undefined],
      [undefined, undefined],
    ] as const) {
      fetch.mockResolvedValue({ source: 'chatgpt', credits, rate_limit_reset_credits: { available_count: 0 }, openai_account: { name: 'fixture' } })
      const result = await buildUsageResponse()
      expect(result.source).toBe('chatgpt')
      expect(result.credits).toEqual(expected)
      expect(result.rate_limit_reset_credits).toEqual({ available_count: 0 })
      expect(result).not.toHaveProperty('openai_account')
    }
    fetch.mockResolvedValue({ source: 'chatgpt', rate_limit_reset_credits: { available_count: -1 } })
    expect((await buildUsageResponse()).rate_limit_reset_credits).toBeUndefined()
    for (const data of [null, {}, { source: 'claude' as const, credits: { balance: 12 }, rate_limit_reset_credits: { available_count: 2 } }]) {
      fetch.mockResolvedValue(data)
      const result = await buildUsageResponse()
      expect(result.source).toBe(data?.source)
      expect(result.credits).toBeUndefined()
      expect(result.rate_limit_reset_credits).toBeUndefined()
    }
  } finally {
    fetch.mockRestore()
  }
})

test('Claude standard rows fill missing fields without replacing valid legacy values or guessing ambiguous rows', async () => {
  const resets_at = '2026-11-04T15:58:17.000Z'
  const legacyReset = '2026-11-05T15:58:17Z'
  const fetch = spyOn(usage, 'fetchUtilization').mockResolvedValue({
    source: 'claude', five_hour: { utilization: 0, resets_at: null },
    seven_day: { utilization: null, resets_at: legacyReset },
    seven_day_oauth_apps: { utilization: 1, resets_at },
    limits: [
      { kind: 'session', group: 'session', percent: 42, resets_at },
      { kind: 'weekly_all', group: 'weekly', percent: 4, resets_at },
      { kind: 'weekly_scoped', percent: 2, resets_at, scope: { model: { display_name: 'Fable' } } },
    ],
  })
  try {
    expect((await buildUsageResponse()).rate_limits).toMatchObject({
      five_hour: { utilization: 0, resets_at },
      seven_day: { utilization: 4, resets_at: legacyReset },
      seven_day_oauth_apps: { utilization: 1, resets_at },
      model_scoped: [{ model_name: 'Fable', resets_at }],
    })
    fetch.mockResolvedValue({
      source: 'claude',
      five_hour: { utilization: null, resets_at: '2026-02-30T15:58:17Z' },
      seven_day: { utilization: 0, resets_at: '7' },
      limits: [
        { kind: 'session', group: 'session', percent: NaN, resets_at },
        { kind: 'weekly_all', group: 'weekly', percent: 3, resets_at },
      ],
    })
    expect((await buildUsageResponse()).rate_limits).toMatchObject({
      five_hour: { utilization: null, resets_at }, seven_day: { utilization: 0, resets_at },
    })
    fetch.mockResolvedValue({
      source: 'claude',
      five_hour: { utilization: 0, resets_at: null },
      seven_day: { utilization: null, resets_at: legacyReset },
      limits: [
        { kind: 'session', group: 'session', percent: 1, resets_at },
        { kind: 'session', group: 'session', percent: 2, resets_at },
        { kind: 'weekly_all', group: 'weekly', percent: 3, resets_at, scope: { surface: { display_name: 'fixture' } } },
      ],
    })
    expect((await buildUsageResponse()).rate_limits).toMatchObject({
      five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: null, resets_at: legacyReset },
    })
    fetch.mockResolvedValue({ source: 'claude', limits: [
      { kind: 'session', group: 'unknown', percent: 1, resets_at },
      { kind: 'weekly_all', group: 'weekly', percent: 2, resets_at: '2026-07-99T15:58:17Z' },
    ] })
    expect((await buildUsageResponse()).rate_limits).toMatchObject({
      five_hour: null, seven_day: { utilization: 2, resets_at: null },
    })
  } finally {
    fetch.mockRestore()
  }
})
