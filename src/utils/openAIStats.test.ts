import assert from 'node:assert/strict'
import test from 'node:test'
import { aggregateOpenAIActivity, formatOpenAITokens } from './openAIStats.js'

test('token summaries use two significant digits and promote rounded units', () => {
  for (const [value, expected] of [
    [14320000, '14M'],
    [400000, '0.4M'],
    [40000, '40K'],
    [1460, '1.5K'],
    [99900, '0.1M'],
    [99900000, '0.1B'],
    [400000000, '0.4B'],
    [999, '1K'],
    [0, '0'],
    [null, '—'],
  ] as const) {
    assert.equal(formatOpenAITokens(value), expected)
  }
})

test('activity uses 52 Sunday weeks, validates dates and sums duplicate days', () => {
  const result = aggregateOpenAIActivity(
    [
      { start_date: '2026-09-06', tokens: 10 },
      { start_date: '2026-09-06', tokens: 5 },
      { start_date: '2026-09-09', tokens: 20 },
      { start_date: '2026-09-10', tokens: 999 },
      { start_date: '2026-02-30', tokens: 999 },
      { start_date: '2020-01-01', tokens: 999 },
      { start_date: '2026-09-08', tokens: -10 },
      { start_date: '2026-09-07', tokens: NaN },
    ],
    '2026-09-09',
  )
  assert.equal(result.daily.length, 364)
  assert.equal(result.daily[0]?.date, '2025-09-14')
  assert.equal(result.daily[357]?.tokens, 15)
  assert.equal(result.weekly.length, 52)
  assert.equal(result.weekly[51]?.tokens, 35)
  assert.equal(result.cumulative[51]?.tokens, 35)
})

test('empty activity is zero-filled and cumulative is window-only', () => {
  assert.ok(
    aggregateOpenAIActivity([], '2026-09-09').daily.every(
      day => day.tokens === 0,
    ),
  )
  const result = aggregateOpenAIActivity(
    [
      { start_date: '2025-09-13', tokens: 1000 },
      { start_date: '2025-09-14', tokens: 2 },
      { start_date: '2025-09-21', tokens: 3 },
    ],
    '2026-09-09',
  )
  assert.equal(result.cumulative[0]?.tokens, 2)
  assert.equal(result.cumulative[1]?.tokens, 5)
  assert.equal(result.cumulative[51]?.tokens, 5)
})
