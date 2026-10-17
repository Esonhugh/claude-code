import { randomUUID } from 'node:crypto'
import type { GoalStatus } from '../commands/goal/types.js'
import type { SDKActiveGoalMessage, SDKMessage } from '../entrypoints/agentSdkTypes.js'
import { getAutoCompactState } from '../services/compact/autoCompact.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { getSessionId, onSessionSwitch } from '../bootstrap/state.js'
import { subscribeSessionInputsChanged } from '../utils/sessionState.js'
import { logError } from '../utils/log.js'
import { toError } from '../utils/errors.js'

/** Official 2.1.292: initial remote snapshots, live updates, and reset-aware deduplication. */
export function createSdkStreamState(options: {
  remote: boolean
  readInputs(): { goal: GoalStatus; model: string; autoCompactWindow?: number }
  enqueue(message: SDKMessage): void
  configurationReady: Promise<unknown>
}): { ready: Promise<void>; refresh(): void; dispose(): void } {
  let disposed = false
  let automaticReady = false
  let reactiveCompact = false
  let session = getSessionId()
  let previousGoal: string | undefined
  let previousAutomatic: string | undefined

  function refresh(): void {
    if (disposed || !options.remote) return
    try {
      const inputs = options.readInputs()
      const sessionId = getSessionId()
      if (sessionId !== session) {
        session = sessionId
        previousAutomatic = undefined
      }
      const goal = inputs.goal
      const value: SDKActiveGoalMessage['value'] = goal.active ? {
        condition: goal.prompt,
        iterations: goal.iterations,
        set_at: goal.setAt,
        ...(goal.tokensAtStart === undefined ? {} : { tokens_at_start: goal.tokensAtStart }),
        ...(goal.lastReason === undefined ? {} : { last_reason: goal.lastReason }),
      } : null
      const goalKey = JSON.stringify(value)
      if (goalKey !== previousGoal) {
        previousGoal = goalKey
        options.enqueue({ type: 'active_goal', value, uuid: randomUUID(), session_id: sessionId })
      }
      if (!automaticReady) return
      const automatic = getAutoCompactState(inputs.model, inputs.autoCompactWindow, reactiveCompact)
      const automaticKey = JSON.stringify(automatic)
      if (automaticKey !== previousAutomatic) {
        previousAutomatic = automaticKey
        options.enqueue({ type: 'autocompact_state', value: automatic, uuid: randomUUID(), session_id: sessionId })
      }
    } catch (error) {
      logError(toError(error))
    }
  }

  const unsubscribe = options.remote ? subscribeSessionInputsChanged(refresh) : () => {}
  const unsubscribeSession = options.remote ? onSessionSwitch(refresh) : () => {}
  refresh()
  const ready = options.remote ? options.configurationReady.catch(error => {
    logError(toError(error))
  }).then(() => {
    if (disposed) return
    // Official latches the remote reactive-compaction gate for this session.
    reactiveCompact = getFeatureValue_CACHED_MAY_BE_STALE('tengu_reactive_compact_remote', false)
    automaticReady = true
    refresh()
  }) : Promise.resolve()

  return {
    ready,
    refresh,
    dispose() {
      disposed = true
      unsubscribe()
      unsubscribeSession()
    },
  }
}
