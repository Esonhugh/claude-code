import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { getSessionId, getTotalOutputTokens, resetStateForTests, switchSession } from '../bootstrap/state.js'
import { restoreSessionCosts } from '../cost-tracker.js'
import type { AppState } from '../state/AppState.js'
import type { SessionCostStateEntry } from '../types/logs.js'
import { asSessionId } from '../types/ids.js'
import { createAttachmentMessage } from '../utils/attachments.js'
import { restoreGoalSessionFromLog } from '../utils/sessionRestore.js'

describe('interactive Goal resume ordering', () => {
  test('restores persisted usage before taking the fresh Goal token baseline', () => {
    const source = readFileSync(new URL('./REPL.tsx', import.meta.url), 'utf8')

    const restoreCosts = source.indexOf(
      'restoreSessionCosts(log)',
    )
    const restoreGoal = source.indexOf(
      'restoreGoalSessionFromLog(messages, setAppState)',
    )

    expect(restoreCosts).toBeGreaterThan(-1)
    expect(restoreGoal).toBeGreaterThan(restoreCosts)

    resetStateForTests()
    try {
      const sessionId = randomUUID()
      switchSession(asSessionId(sessionId), null)
      const costState: SessionCostStateEntry = {
        type: 'cost-state', sessionId,
        totalCostUSD: 1, totalAPIDuration: 0, totalAPIDurationWithoutRetries: 0,
        totalToolDuration: 0, totalLinesAdded: 0, totalLinesRemoved: 0,
        totalDuration: 100, startTime: Date.now() - 100,
        modelUsage: { 'claude-sonnet-4-6': {
          inputTokens: 10, outputTokens: 41, thinkingTokens: 0,
          cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
          webSearchRequests: 0, costUSD: 1,
        } },
      }
      expect(restoreSessionCosts({ sessionId: getSessionId(), costState })).toBe(true)
      expect(getTotalOutputTokens()).toBe(41)

      let appState: Pick<AppState, 'goalStatus' | 'sessionHooks'> = {
        goalStatus: { active: false }, sessionHooks: new Map(),
      }
      restoreGoalSessionFromLog([createAttachmentMessage({
        type: 'goal_status', id: 'resumed-goal', condition: 'finish the task',
        status: 'active', sentinel: true, met: false, failed: false,
        setAt: 100, tokensAtStart: 25,
      })], updater => { appState = updater(appState as AppState) })
      expect(appState.goalStatus).toMatchObject({
        active: true, id: 'resumed-goal', tokensAtStart: 41, iterations: 0,
      })
    } finally {
      resetStateForTests()
    }
  })
})
