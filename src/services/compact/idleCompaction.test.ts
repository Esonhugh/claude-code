import { afterEach, describe, expect, test } from 'bun:test'
import {
  getIdleCompactionDelayMs,
  getIdleCompactionMinTokens,
  getIdleCompactionSkipReason,
} from './idleCompaction.js'

const keys = [
  'CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS',
  'ENABLE_PROMPT_CACHING_1H',
  'CLAUDE_CODE_SESSION_KIND',
  'DISABLE_AUTO_COMPACT',
] as const
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))

afterEach(() => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe('idle compaction', () => {
  test('needs 200K tokens by default; the env minimum is floored at 100K', () => {
    delete process.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS
    expect(getIdleCompactionMinTokens()).toBe(200_000)
    process.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS = '150000'
    expect(getIdleCompactionMinTokens()).toBe(150_000)
    process.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS = '5000'
    expect(getIdleCompactionMinTokens()).toBe(100_000)
    process.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS = 'abc'
    expect(getIdleCompactionMinTokens()).toBe(200_000)
  })

  test('fires at 54 minutes only when the main thread uses the one-hour cache', () => {
    delete process.env.ENABLE_PROMPT_CACHING_1H
    expect(getIdleCompactionDelayMs('repl_main_thread')).toBeNull()
    process.env.ENABLE_PROMPT_CACHING_1H = '1'
    expect(getIdleCompactionDelayMs('repl_main_thread')).toBe(54 * 60_000)
    process.env.CLAUDE_CODE_SESSION_KIND = 'bg'
    expect(getIdleCompactionDelayMs('repl_main_thread')).toBeNull()
  })

  test('skips small conversations, late timers and disabled auto-compact', () => {
    delete process.env.DISABLE_AUTO_COMPACT
    expect(getIdleCompactionSkipReason({ contextTokens: 250_000, lateMs: 0 })).toBeNull()
    expect(getIdleCompactionSkipReason({ contextTokens: 150_000, lateMs: 0 })).toBe('small')
    expect(getIdleCompactionSkipReason({ contextTokens: 250_000, lateMs: 61_000 })).toBe('lapsed')
    process.env.DISABLE_AUTO_COMPACT = '1'
    expect(getIdleCompactionSkipReason({ contextTokens: 250_000, lateMs: 0 })).toBe('compaction_off')
  })
})
