import {
  consumeCacheRebuild,
  isCacheRebuildPending,
} from '../../bootstrap/state.js'
import { formatDuration, formatTokens } from '../../utils/format.js'

// Main-thread prompt cache summary for /usage and /cost, like 2.1.311's
// "Prompt cache (main):" line.

const MIN_MISS_TOKENS = 2_000

type Stats = {
  requests: number
  promptTokens: number
  cacheReadTokens: number
  misses: number
  lastMissAt: number | null
  missRecacheTokens: number
  expectedRebuilds: number
  cachingObserved: boolean
  prevCacheRead: number | null
  last: { at: number; ttl: '5m' | '1h'; promptTokens: number } | null
}

function emptyStats(): Stats {
  return {
    requests: 0,
    promptTokens: 0,
    cacheReadTokens: 0,
    misses: 0,
    lastMissAt: null,
    missRecacheTokens: 0,
    expectedRebuilds: 0,
    cachingObserved: false,
    prevCacheRead: null,
    last: null,
  }
}

let stats = emptyStats()

export function resetPromptCacheStats(): void {
  stats = emptyStats()
}

export function recordMainThreadCacheUsage(
  usage: {
    input_tokens: number
    cache_read_input_tokens?: number | null
    cache_creation_input_tokens?: number | null
  },
  ttl: '5m' | '1h',
  now = Date.now(),
): void {
  const read = usage.cache_read_input_tokens ?? 0
  const created = usage.cache_creation_input_tokens ?? 0
  const prompt = usage.input_tokens + read + created
  stats.requests++
  stats.promptTokens += prompt
  stats.cacheReadTokens += read
  if (read > 0 || created > 0) stats.cachingObserved = true
  const prev = stats.prevCacheRead
  if (prev !== null && read < prev * 0.95 && prev - read >= MIN_MISS_TOKENS) {
    if (consumeCacheRebuild()) {
      stats.expectedRebuilds++
    } else {
      stats.misses++
      stats.lastMissAt = now
      stats.missRecacheTokens += created
    }
  } else {
    consumeCacheRebuild()
  }
  stats.prevCacheRead = read
  stats.last = { at: now, ttl, promptTokens: prompt }
}

export function formatPromptCacheLine(now = Date.now()): string | null {
  const { last } = stats
  if (stats.requests === 0 || last === null) return null
  const parts = [`${stats.requests} ${stats.requests === 1 ? 'request' : 'requests'}`]
  if (stats.promptTokens > 0) {
    parts.push(
      `${Math.round((stats.cacheReadTokens / stats.promptTokens) * 100)}% of input tokens from cache`,
    )
  }
  parts.push(
    stats.misses === 0
      ? 'no misses'
      : `${stats.misses} ${stats.misses === 1 ? 'miss' : 'misses'} (last ${formatDuration(now - (stats.lastMissAt ?? now))} ago, ${formatTokens(stats.missRecacheTokens)} tokens re-cached)`,
  )
  if (stats.expectedRebuilds > 0) {
    parts.push(
      `${stats.expectedRebuilds} expected ${stats.expectedRebuilds === 1 ? 'rebuild' : 'rebuilds'} (compaction or tool-result clearing)`,
    )
  }
  const idle = formatDuration(now - last.at)
  const ttlMs = last.ttl === '1h' ? 60 * 60_000 : 5 * 60_000
  if (!stats.cachingObserved) {
    parts.push('no prompt caching reported by the API')
  } else if (now - last.at < ttlMs) {
    parts.push(`warm (${last.ttl} TTL, last activity ${idle} ago)`)
  } else {
    parts.push(
      `cold — idle ${idle}, ${isCacheRebuildPending() ? 'next turn re-caches the compacted prompt' : `next turn re-caches ~${formatTokens(last.promptTokens)} tokens`}`,
    )
  }
  return `Prompt cache (main):   ${parts.join(' · ')}`
}
