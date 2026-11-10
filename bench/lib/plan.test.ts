import { describe, expect, test } from 'bun:test'
import { makePlan } from './plan'

describe('makePlan', () => {
  const cells = ['fork-claude', 'official', 'codex']
  const tasks = ['a', 'b', 'c', 'd']
  test('every (cell, task) once per round, rep = round', () => {
    const plan = makePlan(cells, tasks, 3, 1)
    expect(plan).toHaveLength(36)
    for (let r = 1; r <= 3; r++) {
      const round = plan.filter(p => p.round === r)
      expect(new Set(round.map(p => `${p.cell}/${p.task}`)).size).toBe(12)
      expect(round.every(p => p.rep === r)).toBe(true)
    }
  })
  test('same seed, same order; CLI order is interleaved, not fixed', () => {
    expect(makePlan(cells, tasks, 3, 5)).toEqual(makePlan(cells, tasks, 3, 5))
    const firsts = new Set<string>()
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const plan = makePlan(cells, tasks, 3, seed)
      for (let i = 0; i < plan.length; i += 3) firsts.add(plan[i].cell)
    }
    expect(firsts.size).toBe(3)
  })
  test('fewer than 3 runs per cell only as a smoke run', () => {
    expect(() => makePlan(cells, tasks, 2, 1)).toThrow(/at least 3/)
    expect(makePlan(cells, tasks, 1, 1, { smoke: true })).toHaveLength(12)
  })
})
