// Per-run metrics from the proxy's request log, and per-cell aggregates.

export type Usage = { input: number; cacheRead: number; cacheWrite: number; cw5m?: number; cw1h?: number; output: number }

export type RequestRecord = {
  ts: string
  model?: string
  effort?: string
  usage?: Record<string, unknown> | null
  ttft_ms?: number
  req_bytes?: number
  status?: number
}

// Anthropic reports uncached input separately; OpenAI's input_tokens includes the cached part.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw provider JSON
export function normalizeUsage(u: Record<string, any> | null | undefined): Usage | null {
  if (!u) return null
  if ('cache_read_input_tokens' in u || 'cache_creation_input_tokens' in u) {
    const cc = u.cache_creation ?? {}
    return {
      input: u.input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      cw5m: cc.ephemeral_5m_input_tokens,
      cw1h: cc.ephemeral_1h_input_tokens,
      output: u.output_tokens ?? 0,
    }
  }
  const d = u.input_tokens_details ?? {}
  const cached = d.cached_tokens ?? 0
  const cw = d.cache_write_tokens ?? 0
  return { input: (u.input_tokens ?? 0) - cached - cw, cacheRead: cached, cacheWrite: cw, output: u.output_tokens ?? 0 }
}

const promptTokens = (u: Usage) => u.input + u.cacheRead + u.cacheWrite

// USD per million tokens, public API list prices used for the 2026-11-07 benchmark
// (docs/features/cache-benchmark.md). Subscriptions are flat-rate; this is the
// API-equivalent price of the same traffic.
export const PRICES_AS_OF = '2026-11-07'
export const PRICES: Record<string, { input: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; output: number }> = {
  'claude-sonnet-5-5': { input: 2, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4, output: 10 },
  'gpt-6.1-sol': { input: 2, cacheRead: 0.1, cacheWrite5m: 0, cacheWrite1h: 0, output: 10 },
}

// When usage does not split cache writes by TTL: Claude Code (fork and
// official) writes 1-hour cache, the other CLIs 5-minute.
export function costUsd(model: string, u: Usage, defaultWriteTtl: '5m' | '1h'): number | null {
  const p = PRICES[model]
  if (!p) return null
  let w5 = u.cw5m
  let w1 = u.cw1h
  if (w5 == null && w1 == null) [w5, w1] = defaultWriteTtl === '1h' ? [0, u.cacheWrite] : [u.cacheWrite, 0]
  return (u.input * p.input + u.cacheRead * p.cacheRead + (w5 ?? 0) * p.cacheWrite5m + (w1 ?? 0) * p.cacheWrite1h + u.output * p.output) / 1e6
}

export type RunMeta = {
  cell: string
  product: string
  side: string
  task: string
  type: string
  length: string
  rep: number
  model: string
  cliVersion?: string
  t0: number
  t1: number
  rc: number | null
  ok: boolean
  smoke?: boolean
}

export type RunResult = {
  cell: string
  product: string
  side: string
  task: string
  type: string
  length: string
  rep: number
  model: string
  effort: string | null
  cliVersion?: string
  ok: boolean
  smoke?: boolean
  requests: number
  mainRequests: number
  usageMissing: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  totalTokens: number
  hitRate: number | null
  firstPrompt: number | null
  cacheBreaks: number
  ttftFirstMs: number | null
  durationS: number
  costUsd: number | null
}

export function analyzeRun(meta: RunMeta, records: RequestRecord[]): RunResult {
  const recs = [...records].sort((a, b) => a.ts.localeCompare(b.ts))
  // Codex prewarms a WebSocket with a ~2 token request; it is not a model turn.
  const rows = recs
    .map(r => [r, normalizeUsage(r.usage)] as const)
    .filter((x): x is readonly [RequestRecord, Usage] => x[1] !== null && promptTokens(x[1]) > 10)
  const main = rows.filter(([r]) => (r.model ?? '').startsWith(meta.model))
  const sum = (k: keyof Usage) => rows.reduce((s, [, u]) => s + ((u[k] as number) ?? 0), 0)
  const tot: Usage = { input: sum('input'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), output: sum('output') }
  if (rows.some(([, u]) => u.cw5m != null || u.cw1h != null)) {
    tot.cw5m = sum('cw5m')
    tot.cw1h = sum('cw1h')
  }
  const allPrompt = promptTokens(tot)
  const ttl = meta.product === 'fork' || meta.product === 'official' ? '1h' : '5m'
  let breaks = 0
  for (let i = 1; i < main.length; i++) {
    const prev = promptTokens(main[i - 1][1])
    if (prev > 2000 && main[i][1].cacheRead < 0.5 * prev) breaks++
  }
  return {
    cell: meta.cell,
    product: meta.product,
    side: meta.side,
    task: meta.task,
    type: meta.type,
    length: meta.length,
    rep: meta.rep,
    model: meta.model,
    effort: main[0]?.[0].effort ?? null,
    cliVersion: meta.cliVersion,
    ok: meta.ok,
    smoke: meta.smoke,
    requests: rows.length,
    mainRequests: main.length,
    usageMissing: recs.filter(r => !r.usage).length,
    input: tot.input,
    cacheRead: tot.cacheRead,
    cacheWrite: tot.cacheWrite,
    output: tot.output,
    totalTokens: allPrompt + tot.output,
    hitRate: allPrompt ? tot.cacheRead / allPrompt : null,
    firstPrompt: main[0] ? promptTokens(main[0][1]) : null,
    cacheBreaks: breaks,
    ttftFirstMs: main[0]?.[0].ttft_ms ?? null,
    durationS: Math.round((meta.t1 - meta.t0) * 10) / 10,
    costUsd: costUsd(meta.model, tot, ttl),
  }
}

export type Stat = { mean: number; min: number; max: number; n: number }

export function stat(xs: number[]): Stat | null {
  if (!xs.length) return null
  return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, min: Math.min(...xs), max: Math.max(...xs), n: xs.length }
}

export type CellSummary = {
  cell: string
  product: string
  side: string
  group: string
  model: string
  effort: string
  cliVersion?: string
  runs: number
  passRate: number
  tokensPerTask: Stat
  costPerTask: Stat | null
  // token-weighted over all runs of the group
  hitRate: number
  // per-run hit rates, for the spread
  hitPerRun: Stat
  enoughRuns: boolean
}

const mostCommon = (xs: string[]) => {
  const n = new Map<string, number>()
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1)
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
}

export const MIN_RUNS_PER_CELL = 3

// One summary per (cell, group); group = 'all' or a task type.
export function summarize(results: RunResult[], groupBy: 'all' | 'type' = 'all'): CellSummary[] {
  const groups = new Map<string, RunResult[]>()
  for (const r of results) {
    if (r.smoke) continue
    const key = `${r.cell}\u0000${groupBy === 'all' ? 'all' : r.type}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  const out: CellSummary[] = []
  for (const [key, rs] of groups) {
    const [cell, group] = key.split('\u0000')
    const prompt = rs.reduce((s, r) => s + r.input + r.cacheRead + r.cacheWrite, 0)
    const costs = rs.map(r => r.costUsd).filter((c): c is number => c != null)
    const perTask = new Map<string, number>()
    for (const r of rs) perTask.set(r.task, (perTask.get(r.task) ?? 0) + 1)
    out.push({
      cell,
      product: rs[0].product,
      side: rs[0].side,
      group,
      model: mostCommon(rs.map(r => r.model)) ?? '',
      effort: mostCommon(rs.map(r => r.effort ?? 'unrecorded')) ?? 'unrecorded',
      cliVersion: mostCommon(rs.flatMap(r => (r.cliVersion ? [r.cliVersion] : []))),
      runs: rs.length,
      passRate: rs.filter(r => r.ok).length / rs.length,
      tokensPerTask: stat(rs.map(r => r.totalTokens))!,
      costPerTask: costs.length === rs.length ? stat(costs) : null,
      hitRate: prompt ? rs.reduce((s, r) => s + r.cacheRead, 0) / prompt : 0,
      hitPerRun: stat(rs.map(r => r.hitRate ?? 0))!,
      enoughRuns: Math.min(...perTask.values()) >= MIN_RUNS_PER_CELL,
    })
  }
  return out.sort((a, b) => a.group.localeCompare(b.group) || a.cell.localeCompare(b.cell))
}
