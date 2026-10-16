import assert from 'node:assert/strict'
import test from 'node:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const { getModelScopedUsageLimits, getOverageIncludedModelAllowlist } =
  await import('./usage-claude.js')

const fableRow = {
  kind: 'weekly_scoped',
  group: 'weekly',
  percent: 37.5,
  resets_at: '2026-10-20T00:00:00Z',
  scope: { model: { display_name: 'Fable' } },
  severity: 'normal',
}

test('model-scoped weekly rows project allowlisted models into usage bars', () => {
  const limits = [
    { kind: 'session', group: 'session', percent: 12, resets_at: null },
    { kind: 'weekly_all', group: 'weekly', percent: 40, resets_at: null },
    fableRow,
    {
      ...fableRow,
      percent: 5,
      scope: { model: { display_name: 'Opus' } },
    },
    {
      ...fableRow,
      percent: 9,
      scope: { surface: { display_name: 'Cowork' } },
    },
    {
      ...fableRow,
      percent: 61,
      resets_at: null,
      scope: { model: { display_name: 'fable 5.1' } },
    },
  ]

  assert.deepEqual(
    getModelScopedUsageLimits(limits, ['Fable', 'Fable 5', 'Fable 5.1']),
    [
      {
        title: 'Current week (Fable)',
        limit: { utilization: 37.5, resets_at: '2026-10-20T00:00:00Z' },
      },
      {
        title: 'Current week (fable 5.1)',
        limit: { utilization: 61, resets_at: null },
      },
    ],
  )
})

test('model-scoped rows are hidden without an allowlist, rows, or a numeric percent', () => {
  assert.deepEqual(getModelScopedUsageLimits([fableRow], []), [])
  assert.deepEqual(getModelScopedUsageLimits(undefined, ['Fable']), [])
  assert.deepEqual(getModelScopedUsageLimits(null, ['Fable']), [])
  assert.deepEqual(
    getModelScopedUsageLimits(
      [{ ...fableRow, percent: 'n/a' as unknown as number }],
      ['Fable'],
    ),
    [],
  )
})

test('the overage-included allowlist defaults to the Fable models', () => {
  assert.deepEqual(getOverageIncludedModelAllowlist(), [
    'Fable',
    'Fable 5',
    'Fable 5.1',
  ])
  assert.deepEqual(getModelScopedUsageLimits([fableRow]), [
    {
      title: 'Current week (Fable)',
      limit: { utilization: 37.5, resets_at: '2026-10-20T00:00:00Z' },
    },
  ])
})
