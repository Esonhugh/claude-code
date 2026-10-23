import { isEnvTruthy } from '../../utils/envUtils.js'
import { sleep } from '../../utils/sleep.js'

// Like official 2.1.303: same-prefix workflow agents are staggered so the first request of a
// group lands alone and warms the prompt cache before its siblings follow. A sibling waits
// for the leader's first response, at most capMs; a warm prefix lets everyone through for
// WARM_MS. A leader that ends without responding releases its waiters.
export const DEFAULT_WORKFLOW_PREFIX_STAGGER_MS = 5000
export const WORKFLOW_PREFIX_WARM_MS = 270_000

type WarmingEntry = { state: 'warming'; ready: Promise<void>; release: () => void }
type WarmEntry = { state: 'warm'; until: number }

export type WorkflowPrefixStaggerTicket = {
  leader: boolean
  waitedMs: number
  responded: () => void
  done: () => void
}

export class WorkflowPrefixStagger {
  private entries = new Map<string, WarmingEntry | WarmEntry>()
  constructor(private now: () => number = Date.now) {}

  async enter(
    key: string,
    options: { capMs: number; signal?: AbortSignal },
  ): Promise<WorkflowPrefixStaggerTicket> {
    const now = this.now()
    for (const [entryKey, entry] of this.entries) {
      if (entry.state === 'warm' && entry.until <= now) this.entries.delete(entryKey)
    }
    const existing = this.entries.get(key)
    let warming: WarmingEntry | undefined
    let waitedMs = 0
    if (existing === undefined) {
      warming = newWarmingEntry()
      this.entries.set(key, warming)
    } else if (existing.state === 'warming' && options.capMs > 0) {
      const waitStart = this.now()
      await waitForLeader(existing.ready, options.capMs, options.signal)
      waitedMs = Math.max(0, this.now() - waitStart)
    }
    let responded = false
    return {
      leader: warming !== undefined,
      waitedMs,
      responded: () => {
        responded = true
        this.markWarm(key)
      },
      done: () => {
        if (responded || warming === undefined) return
        if (this.entries.get(key) === warming) {
          this.entries.delete(key)
          warming.release()
        }
      },
    }
  }

  stateOf(key: string): 'cold' | 'warm' | 'warming' {
    const entry = this.entries.get(key)
    if (entry === undefined) return 'cold'
    if (entry.state === 'warm') return entry.until > this.now() ? 'warm' : 'cold'
    return 'warming'
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      if (entry.state === 'warming') entry.release()
    }
    this.entries.clear()
  }

  private markWarm(key: string): void {
    const previous = this.entries.get(key)
    this.entries.set(key, { state: 'warm', until: this.now() + WORKFLOW_PREFIX_WARM_MS })
    if (previous?.state === 'warming') previous.release()
  }
}

function newWarmingEntry(): WarmingEntry {
  let release!: () => void
  const ready = new Promise<void>(resolve => {
    release = resolve
  })
  return { state: 'warming', ready, release }
}

function waitForLeader(ready: Promise<void>, capMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  const timer = new AbortController()
  const onAbort = () => timer.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  return Promise.race([ready, sleep(capMs, timer.signal)]).finally(() => {
    timer.abort()
    signal?.removeEventListener('abort', onAbort)
  })
}

export function workflowPrefixStaggerCapMs(): number {
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING)) return 0
  const raw = process.env.CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS
  const parsed = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_WORKFLOW_PREFIX_STAGGER_MS
}

export function workflowPrefixStaggerKey(parts: {
  model: string | undefined
  effort: string | number | undefined
  agentType: string | undefined
  toolNames: readonly string[]
  schema: unknown
  cwd: string
}): string {
  return [
    parts.model ?? '',
    String(parts.effort ?? ''),
    parts.agentType ?? '',
    parts.toolNames.join(','),
    parts.schema ? JSON.stringify(parts.schema) : '',
    parts.cwd,
  ].join('\n')
}

const sharedWorkflowPrefixStagger = new WorkflowPrefixStagger()

export function getWorkflowPrefixStagger(): WorkflowPrefixStagger {
  return sharedWorkflowPrefixStagger
}
