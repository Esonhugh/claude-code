import { describe, expect, test } from 'bun:test'
import { analyzeRun, costUsd, normalizeUsage, type RunMeta, summarize } from './metrics'

const meta = (over: Partial<RunMeta> = {}): RunMeta => ({
  cell: 'fork-claude', product: 'fork', side: 'claude', task: 'coding-s', type: 'coding', length: 'short',
  rep: 1, model: 'claude-sonnet-5-5', t0: 100, t1: 130, rc: 0, ok: true, ...over,
})

const anth = (input: number, read: number, write: number, out: number, extra = {}) => ({
  input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: out, ...extra,
})

describe('normalizeUsage', () => {
  test('Anthropic usage keeps uncached input separate', () => {
    expect(normalizeUsage(anth(10, 900, 90, 5, { cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 90 } }))).toEqual({
      input: 10, cacheRead: 900, cacheWrite: 90, cw5m: 0, cw1h: 90, output: 5,
    })
  })
  test('OpenAI input_tokens includes the cached part', () => {
    expect(normalizeUsage({ input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 20 })).toEqual({
      input: 200, cacheRead: 800, cacheWrite: 0, output: 20,
    })
  })
  test('missing usage', () => expect(normalizeUsage(null)).toBeNull())
})

describe('analyzeRun', () => {
  const recs = [
    { ts: '2026-11-07T00:00:02Z', model: 'claude-sonnet-5-5', effort: 'medium', usage: anth(100, 8000, 2000, 50), ttft_ms: 900 },
    { ts: '2026-11-07T00:00:01Z', model: 'claude-sonnet-5-5', effort: 'medium', usage: anth(5000, 0, 5000, 40), ttft_ms: 1200 },
    { ts: '2026-11-07T00:00:03Z', model: 'claude-haiku-5-5', usage: anth(300, 0, 0, 10) },
    { ts: '2026-11-07T00:00:04Z', model: 'claude-sonnet-5-5', usage: anth(1, 0, 0, 1) }, // prewarm-size, dropped
    { ts: '2026-11-07T00:00:05Z', model: 'claude-sonnet-5-5' }, // no usage
  ]
  const r = analyzeRun(meta(), recs)
  test('totals all models, orders by time, drops tiny requests', () => {
    expect(r.requests).toBe(3)
    expect(r.mainRequests).toBe(2)
    expect(r.usageMissing).toBe(1)
    expect(r.input).toBe(5400)
    expect(r.cacheRead).toBe(8000)
    expect(r.cacheWrite).toBe(7000)
    expect(r.totalTokens).toBe(5400 + 8000 + 7000 + 100)
    expect(r.hitRate).toBeCloseTo(8000 / 20400)
    expect(r.firstPrompt).toBe(10000)
    expect(r.ttftFirstMs).toBe(1200)
    expect(r.effort).toBe('medium')
    expect(r.durationS).toBe(30)
  })
  test('a request that reads less than half the previous prompt is a cache break', () => {
    const b = analyzeRun(meta(), [
      { ts: 'a', model: 'claude-sonnet-5-5', usage: anth(10, 9000, 0, 1) },
      { ts: 'b', model: 'claude-sonnet-5-5', usage: anth(9000, 100, 0, 1) },
    ])
    expect(b.cacheBreaks).toBe(1)
  })
  test('fork writes 1-hour cache when usage does not split TTLs', () => {
    const u = { input: 0, cacheRead: 0, cacheWrite: 1_000_000, output: 0 }
    expect(costUsd('claude-sonnet-5-5', u, '1h')).toBeCloseTo(4)
    expect(costUsd('claude-sonnet-5-5', u, '5m')).toBeCloseTo(2.5)
    expect(costUsd('claude-sonnet-5-5', { ...u, cw5m: 500_000, cw1h: 500_000 }, '5m')).toBeCloseTo(3.25)
    expect(costUsd('unknown-model', u, '5m')).toBeNull()
  })
  test('ChatGPT price: cached input at 1/20', () => {
    const c = analyzeRun(meta({ cell: 'codex', product: 'codex', side: 'chatgpt', model: 'gpt-6.1-sol' }), [
      { ts: 'a', model: 'gpt-6.1-sol', usage: { input_tokens: 1_000_000, input_tokens_details: { cached_tokens: 1_000_000 }, output_tokens: 0 } },
    ])
    expect(c.costUsd).toBeCloseTo(0.1)
  })
})

describe('summarize', () => {
  const run = (cell: string, task: string, rep: number, read: number, ok = true, smoke = false) =>
    analyzeRun(meta({ cell, task, rep, ok, smoke }), [{ ts: 'a', model: 'claude-sonnet-5-5', effort: 'medium', usage: anth(1000 - read, read, 0, 0) }])
  test('token-weighted hit, pass rate, min/max/n, smoke runs excluded', () => {
    const rs = [run('a', 't', 1, 900), run('a', 't', 2, 800, false), run('a', 't', 3, 700), run('a', 't', 4, 0, true, true)]
    const [s] = summarize(rs)
    expect(s.runs).toBe(3)
    expect(s.hitRate).toBeCloseTo(0.8)
    expect(s.passRate).toBeCloseTo(2 / 3)
    expect(s.tokensPerTask).toEqual({ mean: 1000, min: 1000, max: 1000, n: 3 })
    expect(s.enoughRuns).toBe(true)
    expect(s.model).toBe('claude-sonnet-5-5')
    expect(s.effort).toBe('medium')
  })
  test('flags cells with fewer than 3 runs of some task', () => {
    const [s] = summarize([run('a', 't', 1, 1), run('a', 't', 2, 1), run('a', 'u', 1, 1), run('a', 'u', 2, 1), run('a', 'u', 3, 1)])
    expect(s.enoughRuns).toBe(false)
  })
  test('groups by task type', () => {
    expect(summarize([run('a', 't', 1, 1)], 'type')[0].group).toBe('coding')
  })
})
