import {
  getIsNonInteractiveSession,
  getSessionId,
  getTotalOutputTokens,
} from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import { checkHasTrustDialogAccepted } from '../../utils/config.js'
import {
  shouldAllowManagedHooksOnly,
  shouldDisableAllHooksIncludingManaged,
} from '../../utils/hooks/hooksConfigSnapshot.js'
import type { HookCommand } from '../../utils/settings/types.js'
import {
  addSessionHook,
  removeSessionHooksBySource,
} from '../../utils/hooks/sessionHooks.js'
import {
  createGoalStatusAttachment,
  finishGoalStatus,
  incrementGoalCheck,
} from './state.js'
import { GOAL_HOOK_ID, type GoalStatusAttachment } from './types.js'

export const GOAL_HOOKS_RESTRICTED_MESSAGE =
  "/goal can't run while hooks are restricted (disableAllHooks or allowManagedHooksOnly is set in settings or by policy)."
export const GOAL_WORKSPACE_UNTRUSTED_MESSAGE =
  '/goal is only available in trusted workspaces. Restart, accept the trust dialog, and try again.'

export function getGoalUnavailableMessage(): string | null {
  if (
    shouldDisableAllHooksIncludingManaged() ||
    shouldAllowManagedHooksOnly()
  ) {
    return GOAL_HOOKS_RESTRICTED_MESSAGE
  }
  if (
    !getIsNonInteractiveSession() &&
    !checkHasTrustDialogAccepted()
  ) {
    return GOAL_WORKSPACE_UNTRUSTED_MESSAGE
  }
  return null
}

export function createGoalStopHook(condition: string): HookCommand {
  return {
    type: 'prompt',
    prompt: condition,
  }
}

type GoalHookParams = {
  setAppState: (updater: (prev: AppState) => AppState) => void
  sessionId: string
  goalId: string
  condition: string
  appendGoalStatusAttachment: (attachment: GoalStatusAttachment) => void
  now?: () => number
  currentTokens?: () => number
}

type GoalHookResult = {
  stopReason?: string
  impossible?: boolean
}

export function recordGoalHookBlock(
  {
    setAppState,
    goalId,
    condition,
    appendGoalStatusAttachment,
  }: GoalHookParams,
  reason: string,
): void {
  let attachment: GoalStatusAttachment | undefined
  setAppState((prev) => {
    const current = prev.goalStatus
    if (
      !current.active ||
      current.id !== goalId ||
      current.prompt !== condition
    ) {
      return prev
    }
    const checkedGoal = incrementGoalCheck(current, reason)
    attachment = createGoalStatusAttachment(
      checkedGoal,
      'active',
      reason,
      undefined,
      undefined,
      { sentinel: false },
    )
    return { ...prev, goalStatus: checkedGoal }
  })
  if (attachment) appendGoalStatusAttachment(attachment)
}

export function clearGoalOnHookSuccess(
  {
    setAppState,
    sessionId,
    goalId,
    condition,
    appendGoalStatusAttachment,
    now = Date.now,
    currentTokens = getTotalOutputTokens,
  }: GoalHookParams,
  result: GoalHookResult = {},
): void {
  const completedAt = now()
  const completedTokens = currentTokens()
  let attachment: GoalStatusAttachment | undefined
  setAppState((prev) => {
    const current = prev.goalStatus
    if (
      !current.active ||
      current.id !== goalId ||
      current.prompt !== condition
    ) {
      return prev
    }
    const status = result.impossible ? 'failed' : 'met'
    const checkedGoal = {
      ...current,
      iterations: current.iterations + 1,
      lastReason: result.stopReason,
    }
    attachment = createGoalStatusAttachment(
      checkedGoal,
      status,
      result.stopReason,
      completedAt,
      completedTokens,
      { sentinel: false },
    )
    return {
      ...prev,
      goalStatus: finishGoalStatus(
        checkedGoal,
        status,
        completedAt,
        completedTokens,
        result.stopReason,
      ),
    }
  })
  if (attachment) {
    appendGoalStatusAttachment(attachment)
    removeSessionHooksBySource(setAppState, sessionId, 'Stop', GOAL_HOOK_ID)
  }
}

export function removeGoalStopHook(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
): void {
  removeSessionHooksBySource(setAppState, sessionId, 'Stop', GOAL_HOOK_ID)
}

export function clearGoal(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
): {
  clearedGoal?: string
  attachment?: GoalStatusAttachment
} {
  let clearedGoal: string | undefined
  let attachment: GoalStatusAttachment | undefined
  setAppState((prev) => {
    if (!prev.goalStatus.active) return prev
    clearedGoal = prev.goalStatus.prompt
    attachment = createGoalStatusAttachment(prev.goalStatus, 'cleared')
    return { ...prev, goalStatus: { active: false } }
  })
  removeGoalStopHook(setAppState, sessionId)
  return { clearedGoal, attachment }
}

export function registerGoalStopHook(params: GoalHookParams): void {
  removeGoalStopHook(params.setAppState, params.sessionId)
  addSessionHook(
    params.setAppState,
    params.sessionId,
    'Stop',
    '',
    createGoalStopHook(params.condition),
    (_hook, result) => clearGoalOnHookSuccess(params, result),
    GOAL_HOOK_ID,
  )
}

export function restoreGoalStopHook(
  setAppState: GoalHookParams['setAppState'],
  appendGoalStatusAttachment: GoalHookParams['appendGoalStatusAttachment'],
  sessionId: string = getSessionId(),
): void {
  let activeGoal: Extract<AppState['goalStatus'], { active: true }> | undefined
  setAppState((prev) => {
    if (prev.goalStatus.active) activeGoal = prev.goalStatus
    return prev
  })
  removeGoalStopHook(setAppState, sessionId)
  if (!activeGoal) return
  if (getGoalUnavailableMessage()) {
    setAppState((prev) =>
      prev.goalStatus.active
        ? { ...prev, goalStatus: { active: false } }
        : prev,
    )
    return
  }

  registerGoalStopHook({
    setAppState,
    sessionId,
    goalId: activeGoal.id,
    condition: activeGoal.prompt,
    appendGoalStatusAttachment,
  })
}
