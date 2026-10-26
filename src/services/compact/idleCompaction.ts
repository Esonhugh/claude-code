import { getCacheControl } from '../api/claude.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import type { QuerySource } from '../../constants/querySource.js'
import { isAutoCompactEnabled } from './autoCompact.js'

// Official 2.1.299 idle compaction: a long conversation idle for ~54 minutes is
// compacted before its one-hour prompt cache expires, so the next message does
// not reprocess the whole conversation at full price.
const ONE_HOUR_MS = 60 * 60_000
const FIRE_AT_FRACTION = 0.9
const DEFAULT_MIN_TOKENS = 200_000
const MIN_MIN_TOKENS = 100_000
// A timer that fires this late (laptop asleep) finds the cache already gone.
const MAX_LATE_MS = 60_000

export const IDLE_COMPACTION_NOTICE =
  'Compacted while idle, before the prompt cache expired · turn off with "idleCompaction": false in settings.json'

export function isIdleCompactionEnabled(): boolean {
  return getInitialSettings().idleCompaction !== false
}

export function getIdleCompactionMinTokens(): number {
  const raw = Number(process.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS)
  return Number.isFinite(raw) && raw > 0
    ? Math.max(MIN_MIN_TOKENS, raw)
    : DEFAULT_MIN_TOKENS
}

/** Delay from the end of the last main-thread turn, or null when the cache is not one hour. */
export function getIdleCompactionDelayMs(querySource: QuerySource): number | null {
  if (process.env.CLAUDE_CODE_SESSION_KIND === 'bg') return null
  if (getCacheControl({ querySource }).ttl !== '1h') return null
  return ONE_HOUR_MS * FIRE_AT_FRACTION
}

export type IdleCompactionSkip =
  | 'disabled'
  | 'compaction_off'
  | 'lapsed'
  | 'small'

export function getIdleCompactionSkipReason({
  contextTokens,
  lateMs,
}: {
  contextTokens: number
  lateMs: number
}): IdleCompactionSkip | null {
  if (!isIdleCompactionEnabled()) return 'disabled'
  if (!isAutoCompactEnabled()) return 'compaction_off'
  if (lateMs > MAX_LATE_MS) return 'lapsed'
  if (contextTokens < getIdleCompactionMinTokens()) return 'small'
  return null
}
