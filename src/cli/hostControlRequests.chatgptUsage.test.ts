import { expect, test } from 'bun:test'

import type { RateLimit, Utilization } from '../services/api/usage.js'
import { chatGPTRateLimits } from './hostControlRequests.js'

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
