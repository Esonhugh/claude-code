// The Stats dialog's numbers, computed like the prototype's statsBody from
// /stats data (src/utils/stats.ts): days end today, tokens are in thousands.
import type { Stats } from './extApi'

export type StatRange = '7d' | '30d' | 'all'
export type StatDay = { dt: Date; key: string; tok: number[]; sessions: number }
export type StatPoint = { label: string; tok: number[]; week?: boolean }

export const SERIES_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)']

const pad = (n: number) => String(n).padStart(2, '0')
export const dayKey = (dt: Date) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
export const dLabel = (dt: Date) => `${dt.getMonth() + 1}/${dt.getDate()}`

/** Thousands of tokens as the prototype prints them: `60k`, `1.5M`, `0.4k`. */
export function fmtK(k: number): string {
  if (k >= 1000) return `${(k / 1000).toFixed(1)}M`
  if (k > 0 && k < 10) return `${Number(k.toFixed(1))}k`
  return `${Math.round(k)}k`
}

/** A raw token count: 458k, 2.8B. */
export function fmtTokens(n: number | null): string {
  if (n === null || !Number.isFinite(n) || n < 0) return '—'
  if (n >= 1e9) return `${Number((n / 1e9).toFixed(1))}B`
  if (n >= 1e6) return `${Number((n / 1e6).toFixed(1))}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}

export function fmtDuration(ms: number): string {
  const m = Math.round(ms / 60_000)
  return m >= 60 ? `${Math.floor(m / 60)}h${pad(m % 60)}m` : `${m}m`
}

/** The three models with the most tokens overall; the chart has three series colors. */
export function topModels(stats: Stats): string[] {
  const totals = new Map<string, number>()
  for (const d of stats.tokens) {
    for (const [m, n] of Object.entries(d.byModel)) totals.set(m, (totals.get(m) ?? 0) + n)
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, SERIES_COLORS.length)
    .map(([m]) => m)
}

/** One entry per calendar day, oldest first, from the first recorded day (at least 180) to today. */
export function statDays(stats: Stats, models: string[], today = new Date()): StatDay[] {
  const tokens = new Map(stats.tokens.map(d => [d.date, d.byModel]))
  const sessions = new Map(stats.days.map(d => [d.date, d.sessions]))
  const first = [...tokens.keys(), ...sessions.keys()].sort()[0]
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  let span = 180
  if (first) {
    const [y, m, d] = first.split('-').map(Number) as [number, number, number]
    span = Math.max(span, Math.round((end.getTime() - new Date(y, m - 1, d).getTime()) / 864e5) + 1)
  }
  const out: StatDay[] = []
  for (let i = span - 1; i >= 0; i--) {
    const dt = new Date(end.getFullYear(), end.getMonth(), end.getDate() - i)
    const key = dayKey(dt)
    const by = tokens.get(key) ?? {}
    out.push({ dt, key, tok: models.map(m => (by[m] ?? 0) / 1000), sessions: sessions.get(key) ?? 0 })
  }
  return out
}

export function rangeDays(days: StatDay[], range: StatRange): StatDay[] {
  if (range === 'all') {
    const first = days.findIndex(d => d.sessions > 0 || d.tok.some(v => v > 0))
    return days.slice(first < 0 ? -180 : Math.min(first, days.length - 7))
  }
  return days.slice(range === '7d' ? -7 : -30)
}

/** 7d/30d plot days; "all" plots weekly sums so the curve stays readable. */
export function statSeries(days: StatDay[], range: StatRange, models: number): StatPoint[] {
  if (range !== 'all') return days.map(d => ({ label: dLabel(d.dt), tok: d.tok }))
  const out: StatPoint[] = []
  for (let i = 0; i < days.length; i += 7) {
    const wk = days.slice(i, i + 7)
    out.push({
      label: dLabel(wk[0]!.dt),
      tok: Array.from({ length: models }, (_, m) => wk.reduce((s, d) => s + (d.tok[m] ?? 0), 0)),
      week: true,
    })
  }
  return out
}

const total = (d: { tok: number[] }) => d.tok.reduce((a, b) => a + b, 0)
export const dayTotal = total

export function summary(days: StatDay[], stats: Stats) {
  const n = days[0]?.tok.length ?? 0
  const tot = Array.from({ length: n }, (_, m) => days.reduce((s, d) => s + d.tok[m]!, 0))
  const all = tot.reduce((a, b) => a + b, 0)
  const fav = tot.indexOf(Math.max(...tot))
  let best = 0
  let run = 0
  for (const d of days) {
    run = d.sessions ? run + 1 : 0
    best = Math.max(best, run)
  }
  const peak = days.reduce((a, d) => (total(d) > total(a) ? d : a), days[0]!)
  const hourTotal = stats.hours.reduce((a, b) => a + b, 0)
  const peakHour = hourTotal ? stats.hours.indexOf(Math.max(...stats.hours)) : undefined
  return {
    tot,
    all,
    fav,
    active: days.filter(d => total(d) > 0).length,
    sessions: days.reduce((s, d) => s + d.sessions, 0),
    current: stats.streaks.current,
    best,
    peak,
    peakHour,
  }
}

/** Heat level 0–4: 0 is no use, then the quartiles of the active days shown. */
export function heatLevels(days: StatDay[]): number[] {
  const values = days.map(total)
  const active = values.filter(v => v > 0).sort((a, b) => a - b)
  const q = [0.25, 0.5, 0.75].map(p => active[Math.floor(p * (active.length - 1))] ?? 0)
  return values.map(v => (v === 0 ? 0 : v <= q[0]! ? 1 : v <= q[1]! ? 2 : v <= q[2]! ? 3 : 4))
}

/** The heatmap's days: the last 24 full weeks plus this week up to today (25 columns). */
export function heatDays(days: StatDay[]): StatDay[] {
  const last = days.at(-1)
  return last ? days.slice(-(7 * 24 + last.dt.getDay() + 1)) : []
}

export function hourShares(hours: number[]): number[] {
  const sum = hours.reduce((a, b) => a + b, 0)
  return hours.map(h => (sum ? Math.round((h / sum) * 100) : 0))
}

/** The part of day the peak hour falls in, for "下午最常用". */
export function dayPart(hour: number): string {
  return hour < 6 ? '凌晨' : hour < 12 ? '上午' : hour < 18 ? '下午' : '晚上'
}
