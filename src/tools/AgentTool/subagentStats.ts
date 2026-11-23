import { getSessionId } from '../../bootstrap/state.js'

/**
 * Official 2.1.329 result.subagent_stats: what the Agent tool did with
 * subagents this session. Cumulative across turns like modelUsage, back to
 * zero when the session changes (/clear, resume). A background subagent that
 * outlives the change records its outcome in the new counts. Forked skills,
 * workflow agents, teammates and internal agents are not counted. A remote
 * launch is counted as spawned with no outcome.
 */
export type SubagentKillReason = 'parent' | 'user' | 'system'
export type SubagentRefusal = 'depth_limit' | 'concurrency_limit' | 'budget'

type Counts = {
  spawned: number
  requested: { background: number; foreground: number; unset: number }
  started_in_background: number
  max_depth: number
  spawned_by_subagents: number
  completed: number
  failed: number
  killed: Record<SubagentKillReason, number>
  refused: Record<SubagentRefusal, number>
}

export type SubagentStats = Counts & { by_type: Record<string, number> }

type Outcome = 'completed' | 'failed' | 'killed'

const emptyCounts = (): Counts => ({
  spawned: 0,
  requested: { background: 0, foreground: 0, unset: 0 },
  started_in_background: 0,
  max_depth: 0,
  spawned_by_subagents: 0,
  completed: 0,
  failed: 0,
  killed: { parent: 0, user: 0, system: 0 },
  refused: { depth_limit: 0, concurrency_limit: 0, budget: 0 },
})

/** One spawned subagent's outcome; the first one recorded counts. */
export class SubagentOutcome {
  #counts: Counts
  #outcome: Outcome | undefined

  constructor(counts: Counts) {
    this.#counts = counts
  }

  completed(): void {
    if (this.#settle('completed')) this.#counts.completed += 1
  }

  failed(): void {
    if (this.#settle('failed')) this.#counts.failed += 1
  }

  killed(reason: SubagentKillReason = 'user'): void {
    if (this.#settle('killed')) this.#counts.killed[reason] += 1
  }

  /** A sync subagent that finished, then had its result cancelled by the user. */
  cancelledAfterCompletion(): void {
    if (this.#outcome === 'completed') {
      this.#counts.completed -= 1
      this.#outcome = undefined
    }
    this.killed('user')
  }

  #settle(outcome: Outcome): boolean {
    if (this.#outcome !== undefined) return false
    this.#outcome = outcome
    return true
  }
}

class SubagentStatsTracker {
  #counts = emptyCounts()
  #byType = new Map<string, number>()

  recordSpawn(spawn: {
    agentType: string
    /** The model's run_in_background, undefined when omitted or not offered. */
    runInBackground: boolean | undefined
    runsInBackground: boolean
    depth: number
  }): SubagentOutcome {
    const counts = this.#counts
    counts.spawned += 1
    counts.requested[
      spawn.runInBackground === undefined ? 'unset' : spawn.runInBackground ? 'background' : 'foreground'
    ] += 1
    if (spawn.runsInBackground) counts.started_in_background += 1
    this.#byType.set(spawn.agentType, (this.#byType.get(spawn.agentType) ?? 0) + 1)
    counts.max_depth = Math.max(counts.max_depth, spawn.depth)
    if (spawn.depth > 1) counts.spawned_by_subagents += 1
    return new SubagentOutcome(counts)
  }

  recordRefused(reason: SubagentRefusal): void {
    this.#counts.refused[reason] += 1
  }

  snapshot(): SubagentStats {
    const counts = this.#counts
    return {
      ...counts,
      requested: { ...counts.requested },
      killed: { ...counts.killed },
      refused: { ...counts.refused },
      by_type: Object.fromEntries(this.#byType),
    }
  }

  reset(): void {
    Object.assign(this.#counts, emptyCounts())
    this.#byType.clear()
  }
}

const tracker = new SubagentStatsTracker()
let trackedSessionId: string | undefined

/** The current session's tracker; a new session starts from zero. */
export function subagentStats(): SubagentStatsTracker {
  const sessionId = getSessionId()
  if (trackedSessionId !== sessionId) {
    if (trackedSessionId !== undefined) tracker.reset()
    trackedSessionId = sessionId
  }
  return tracker
}
