import { expect, test } from 'bun:test'
import { logTicks, modelEffortNotes, paretoFront, scatterSvg } from './chart'
import type { CellSummary } from './metrics'

const s = (cell: string, product: string, side: string, tokens: number, hit: number, cost: number | null): CellSummary => ({
  cell, product, side, group: 'all', model: side === 'chatgpt' ? 'gpt-6.1-sol' : 'claude-sonnet-5-5', effort: 'medium', runs: 33, passRate: 1,
  tokensPerTask: { mean: tokens, min: tokens, max: tokens, n: 33 },
  costPerTask: cost == null ? null : { mean: cost, min: cost, max: cost, n: 33 },
  hitRate: hit, hitPerRun: { mean: hit, min: hit, max: hit, n: 33 }, enoughRuns: true,
})

const cells = [
  s('fork-claude', 'fork', 'claude', 72700, 0.871, 0.078),
  s('official', 'official', 'claude', 81000, 0.873, 0.088),
  s('codex', 'codex', 'chatgpt', 80300, 0.888, 0.047),
  s('pi-claude', 'pi', 'claude-key', 21400, 0.734, 0.051),
]

test('Pareto front keeps points no other point beats on both axes', () => {
  const f = paretoFront([{ x: 1, y: 50 }, { x: 2, y: 40 }, { x: 3, y: 60 }, { x: 4, y: 60 }])
  expect(f).toEqual([{ x: 1, y: 50 }, { x: 3, y: 60 }])
})

test('log ticks', () => {
  expect(logTicks(9, 260)).toEqual([10, 20, 30, 50, 100, 200])
  expect(logTicks(0.015, 0.3)).toEqual([0.02, 0.03, 0.05, 0.1, 0.2, 0.3])
})

test('scatter SVG: one mark and label per cell, model and effort stated per cell', () => {
  for (const metric of ['tokens', 'cost'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      const svg = scatterSvg({ metric, summaries: cells }, theme)
      expect(svg.startsWith('<svg')).toBe(true)
      expect(svg.endsWith('</svg>')).toBe(true)
      for (const label of ['本仓库 · Claude', '官方 · Claude', 'Codex · ChatGPT', 'pi · Claude API']) expect(svg).toContain(label)
      expect(svg).toContain('codex: gpt-6.1-sol / medium')
      expect(svg).toContain(metric === 'cost' ? '$0.05' : '50k')
    }
  }
  expect(modelEffortNotes(cells)).toHaveLength(2)
})

test('cells without a cost are left out of the cost chart', () => {
  const svg = scatterSvg({ metric: 'cost', summaries: [...cells.slice(0, 3), s('x', 'dsh', 'chatgpt', 1000, 0.5, null)] }, 'light')
  expect(svg).not.toContain('dsh · ChatGPT')
})
