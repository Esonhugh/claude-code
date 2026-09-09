import type { OpenAIActivityStats } from '../services/api/usage-types.js'

export function formatOpenAITokens(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    return '—'
  const rounded = Number(value.toPrecision(2))
  const [unit, suffix] =
    rounded >= 100_000_000
      ? ([1e9, 'B'] as const)
      : rounded >= 100_000
        ? ([1e6, 'M'] as const)
        : rounded >= 1000
          ? ([1e3, 'K'] as const)
          : ([1, ''] as const)
  return `${Number((rounded / unit).toPrecision(2))}${suffix}`
}

export function aggregateOpenAIActivity(
  buckets: OpenAIActivityStats['daily_usage_buckets'],
  today: string,
) {
  const dayMs = 86_400_000
  const end = Date.parse(today)
  const start = end - (new Date(end).getUTCDay() + 51 * 7) * dayMs
  const daily = Array.from({ length: 364 }, (_, index) => ({
    date: new Date(start + index * dayMs).toISOString().slice(0, 10),
    tokens: 0,
  }))
  for (const bucket of Array.isArray(buckets) ? buckets : []) {
    if (!bucket || !/^\d{4}-\d{2}-\d{2}$/.test(bucket.start_date)) continue
    const date = Date.parse(bucket.start_date)
    if (
      !Number.isFinite(date) ||
      new Date(date).toISOString().slice(0, 10) !== bucket.start_date
    )
      continue
    const index = (date - start) / dayMs
    if (date > end || !daily[index] || !Number.isFinite(bucket.tokens)) continue
    daily[index]!.tokens += Math.max(0, bucket.tokens)
  }
  const weekly = Array.from({ length: 52 }, (_, index) => ({
    date: daily[index * 7]!.date,
    tokens: daily
      .slice(index * 7, index * 7 + 7)
      .reduce((sum, day) => sum + day.tokens, 0),
  }))
  let total = 0
  const cumulative = weekly.map(week => ({
    ...week,
    tokens: (total += week.tokens),
  }))
  return { daily, weekly, cumulative }
}
