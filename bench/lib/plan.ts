import { MIN_RUNS_PER_CELL } from './metrics'

export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function shuffle<T>(xs: T[], rand: () => number): T[] {
  const out = [...xs]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export type PlannedRun = { round: number; rep: number; cell: string; task: string }

// Round r runs every (task, cell) pair once, as repetition r. Within a round the
// tasks come in a seeded order and, per task, the CLIs in a seeded order, so no
// CLI always runs first (cold) or last (after the others warmed shared caches).
export function makePlan(cells: string[], tasks: string[], reps: number, seed: number, opts: { smoke?: boolean } = {}): PlannedRun[] {
  if (reps < MIN_RUNS_PER_CELL && !opts.smoke) throw new Error(`need at least ${MIN_RUNS_PER_CELL} runs per cell (got ${reps}); use --smoke for a quick check`)
  const rand = rng(seed)
  const plan: PlannedRun[] = []
  for (let r = 1; r <= reps; r++) {
    for (const task of shuffle(tasks, rand)) {
      for (const cell of shuffle(cells, rand)) plan.push({ round: r, rep: r, cell, task })
    }
  }
  return plan
}
