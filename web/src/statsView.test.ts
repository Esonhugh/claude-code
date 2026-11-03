import { describe, expect, it } from 'bun:test'
import type { Stats } from './extApi'
import {
  dayPart,
  fmtDuration,
  fmtK,
  fmtTokens,
  heatDays,
  heatLevels,
  hourShares,
  rangeDays,
  statDays,
  statSeries,
  summary,
  topModels,
} from './statsView'

const stats: Stats = {
  days: [
    { date: '2026-10-31', sessions: 2, messages: 10 },
    { date: '2026-11-01', sessions: 1, messages: 4 },
    { date: '2026-11-02', sessions: 3, messages: 9 },
  ],
  tokens: [
    { date: '2026-10-31', byModel: { 'Opus 5.5': 60_000, 'Haiku 5.5': 2_000 } },
    { date: '2026-11-01', byModel: { 'Sonnet 5.5': 20_000 } },
    { date: '2026-11-02', byModel: { 'Opus 5.5': 40_000, 'Fable 5': 500 } },
  ],
  streaks: { current: 3, longest: 5 },
  longestSessionMs: (2 * 60 + 14) * 60_000,
  hours: Array.from({ length: 24 }, (_, h) => (h === 15 ? 6 : h === 9 ? 2 : 0)),
  totalSessions: 6,
}
const today = new Date(2026, 10, 2)

describe('statsView', () => {
  it('formats like the prototype', () => {
    expect(fmtK(60)).toBe('60k')
    expect(fmtK(1500)).toBe('1.5M')
    expect(fmtK(0.5)).toBe('0.5k')
    expect(fmtK(0)).toBe('0k')
    expect(fmtTokens(52_700_361_041)).toBe('52.7B')
    expect(fmtTokens(2_806_437_392)).toBe('2.8B')
    expect(fmtTokens(458_716)).toBe('459k')
    expect(fmtTokens(null)).toBe('—')
    expect(fmtDuration(stats.longestSessionMs)).toBe('2h14m')
    expect(fmtDuration(5 * 60_000)).toBe('5m')
    expect(dayPart(15)).toBe('下午')
    expect(dayPart(3)).toBe('凌晨')
  })

  it('keeps the top three models and fills every day up to today', () => {
    const models = topModels(stats)
    expect(models).toEqual(['Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5'])
    const days = statDays(stats, models, today)
    expect(days).toHaveLength(180)
    expect(days.at(-1)).toMatchObject({ key: '2026-11-02', tok: [40, 0, 0], sessions: 3 })
    expect(days.at(-3)).toMatchObject({ key: '2026-10-31', tok: [60, 0, 2], sessions: 2 })
  })

  it('summarizes a range like the KPI tiles', () => {
    const models = topModels(stats)
    const days = rangeDays(statDays(stats, models, today), '7d')
    expect(days).toHaveLength(7)
    const s = summary(days, stats)
    expect(s.all).toBe(122)
    expect(models[s.fav]).toBe('Opus 5.5')
    expect(s).toMatchObject({ active: 3, sessions: 6, current: 3, best: 3, peakHour: 15 })
    expect(s.peak.key).toBe('2026-10-31')
  })

  it('plots weekly sums for all time', () => {
    const models = topModels(stats)
    const days = rangeDays(statDays(stats, models, today), 'all')
    const pts = statSeries(days, 'all', models.length)
    expect(pts.every(p => p.week)).toBe(true)
    expect(pts.reduce((s, p) => s + p.tok[0]!, 0)).toBe(100)
  })

  it('builds 25 heatmap columns with levels and hour shares', () => {
    const days = statDays(stats, topModels(stats), today)
    const heat = heatDays(days)
    // Monday 2026-11-02: 24 full weeks plus Sunday and Monday.
    expect(heat).toHaveLength(7 * 24 + 2)
    expect(heat[0]!.dt.getDay()).toBe(0)
    const levels = heatLevels(heat)
    expect(levels.filter(l => l > 0)).toHaveLength(3)
    expect(levels.at(-3)).toBe(4)
    expect(hourShares(stats.hours)[15]).toBe(75)
  })
})
