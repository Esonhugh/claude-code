import { afterEach, expect, spyOn, test } from 'bun:test'

import * as usage from '../services/api/usage.js'
import * as statsUtils from '../utils/stats.js'
import { loadStats } from './extensions.js'

const spies: { mockRestore(): void }[] = []
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})

function stubLocalStats() {
  spies.push(
    spyOn(statsUtils, 'aggregateClaudeCodeStats').mockResolvedValue({
      dailyActivity: [],
      dailyModelTokens: [],
      streaks: { currentStreak: 0, longestStreak: 0 },
      longestSession: null,
      hourCounts: {},
      totalSessions: 0,
    } as never),
  )
}

test('Stats carries the ChatGPT account activity with no local sessions', async () => {
  stubLocalStats()
  spies.push(
    spyOn(usage, 'fetchOpenAIActivity').mockResolvedValue({
      lifetime_tokens: 52_700_361_041,
      peak_daily_tokens: 2_806_437_392,
      current_streak_days: 57,
      longest_streak_days: 57,
      longest_running_turn_sec: 70_144,
      daily_usage_buckets: [{ start_date: '2025-11-30', tokens: 458_716 }],
    }),
  )
  expect((await loadStats()).codex).toEqual({
    lifetimeTokens: 52_700_361_041,
    peakDailyTokens: 2_806_437_392,
    currentStreakDays: 57,
    longestStreakDays: 57,
    longestTurnSec: 70_144,
    daily: [{ date: '2025-11-30', tokens: 458_716 }],
  })
})

test('Stats still loads when the ChatGPT activity request fails', async () => {
  stubLocalStats()
  spies.push(spyOn(usage, 'fetchOpenAIActivity').mockRejectedValue(new Error('401')))
  const stats = await loadStats()
  expect(stats.codex).toBeNull()
  expect(stats.totalSessions).toBe(0)
})
