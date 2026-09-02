import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('interactive Goal resume ordering', () => {
  test('restores persisted usage before taking the fresh Goal token baseline', () => {
    const source = readFileSync(new URL('./REPL.tsx', import.meta.url), 'utf8')

    const restoreCosts = source.indexOf(
      'setCostStateForRestore(targetSessionCosts)',
    )
    const restoreGoal = source.indexOf(
      'restoreGoalSessionFromLog(messages, setAppState)',
    )

    expect(restoreCosts).toBeGreaterThan(-1)
    expect(restoreGoal).toBeGreaterThan(restoreCosts)
  })
})
