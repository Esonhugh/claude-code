import { beforeEach, expect, test } from 'bun:test'
import { markPostCompaction } from '../../bootstrap/state.js'
import { formatPromptCacheLine, recordMainThreadCacheUsage, resetPromptCacheStats } from './promptCacheStats.js'

beforeEach(() => resetPromptCacheStats())

test('a session without caching reads like 2.1.311', () => {
  recordMainThreadCacheUsage({ input_tokens: 20 }, '1h', 1_000)
  expect(formatPromptCacheLine(1_000)).toBe(
    'Prompt cache (main):   1 request · 0% of input tokens from cache · no misses · no prompt caching reported by the API',
  )
})

test('hits, a miss and a compaction rebuild are counted separately', () => {
  recordMainThreadCacheUsage({ input_tokens: 10, cache_creation_input_tokens: 20_000 }, '1h', 0)
  recordMainThreadCacheUsage({ input_tokens: 10, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 500 }, '1h', 1_000)
  recordMainThreadCacheUsage({ input_tokens: 10, cache_creation_input_tokens: 21_000 }, '1h', 2_000)
  markPostCompaction()
  recordMainThreadCacheUsage({ input_tokens: 10, cache_creation_input_tokens: 4_000 }, '1h', 3_000)
  recordMainThreadCacheUsage({ input_tokens: 10, cache_read_input_tokens: 4_000 }, '1h', 4_000)
  const line = formatPromptCacheLine(5_000)!
  expect(line).toContain('5 requests')
  expect(line).toContain('1 miss (last 3s ago, 21k tokens re-cached)')
  expect(line).not.toContain('expected rebuild')
  expect(line).toContain('warm (1h TTL, last activity 1s ago)')
})
