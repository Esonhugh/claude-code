import { expect, test } from 'bun:test'
import { createModsRuntime } from './runtime.js'

test.each([undefined, 1000])('prompt edit budget is configurable while the default remains 50ms: %s', async budget => {
  const runtime = createModsRuntime({ promptEditBudgetMs: budget })
  runtime.registerHostCallback({ tier: 'user', registration: { id: 1, event: 'prompt.edit', hasCatch: false } },
    async (_engine, input, next) => ({ text: String(next.budget.ms), cursor: 0 }))
  try {
    expect(await runtime.dispatch('prompt.edit', {
      origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'x',
    }, async () => ({ text: 'x', cursor: 1 }))).toEqual({ text: String(budget ?? 50), cursor: 0 })
  } finally { await runtime.dispose() }
})

test.each([0, -1, NaN, Infinity])('prompt edit budget cannot disable finite watchdogs: %s', budget => {
  expect(() => createModsRuntime({ promptEditBudgetMs: budget })).toThrow('promptEditBudgetMs must be a positive finite number')
})
