import type { AppState } from '../../state/AppState.js'
import type { HookCommand } from '../../utils/settings/types.js'
import {
  addSessionHook,
  removeSessionHook,
} from '../../utils/hooks/sessionHooks.js'
import { createGoalStatusAttachment, finishGoalStatus } from './state.js'
import { GOAL_HOOK_ID, type GoalStatusAttachment } from './types.js'

export const goalStopHookPrompt = `
You are the /goal StopHook verifier. Inspect the current conversation and transcript to decide whether the active /goal objective is fully completed.

Hook input JSON:
$ARGUMENTS

Decision rules:
- Return ok: true only if the latest /goal objective has a verified final result and no unresolved required work remains.
- Return ok: true if there is no active /goal objective in the transcript.
- Return ok: true if the latest /goal command is clear, because that explicitly clears any active objective.
- Return ok: true if stop_hook_active is true and the last assistant message is still genuinely blocked by permissions, missing credentials, or a user-only decision.
- Return ok: false when the objective is partially complete, unverified, has failing checks, still has in-progress tasks, or can be continued autonomously with available tools.
- When returning ok: false, the reason must be a concrete continuation instruction for the main assistant. Include what remains, what to do next, and any checks to run. The main assistant will receive this reason as hidden Stop hook feedback and continue without human intervention.
`

export const goalStopHook: HookCommand = {
  type: 'prompt',
  prompt: goalStopHookPrompt,
  statusMessage: 'verifying goal completion',
}

type GoalHookParams = {
  setAppState: (updater: (prev: AppState) => AppState) => void
  sessionId: string
  goalId: string
  condition: string
  appendGoalStatusAttachment: (attachment: GoalStatusAttachment) => void
  now?: () => number
}

export function clearGoalOnHookSuccess({
  setAppState,
  sessionId,
  goalId,
  condition,
  appendGoalStatusAttachment,
  now = Date.now,
}: GoalHookParams): void {
  let shouldRemoveHook = false
  setAppState(prev => {
    const current = prev.goalStatus
    if (!current.active || current.id !== goalId || current.prompt !== condition) {
      return prev
    }
    appendGoalStatusAttachment(createGoalStatusAttachment(current, 'met'))
    shouldRemoveHook = true
    return {
      ...prev,
      goalStatus: finishGoalStatus(current, 'met', now()),
    }
  })
  if (shouldRemoveHook) {
    removeSessionHook(setAppState, sessionId, 'Stop', goalStopHook)
  }
}

export function removeGoalStopHook(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
): void {
  removeSessionHook(setAppState, sessionId, 'Stop', goalStopHook)
}

export function registerGoalStopHook(params: GoalHookParams): void {
  removeGoalStopHook(params.setAppState, params.sessionId)
  addSessionHook(
    params.setAppState,
    params.sessionId,
    'Stop',
    '',
    goalStopHook,
    () => clearGoalOnHookSuccess(params),
    GOAL_HOOK_ID,
  )
}
