import type {
  GoalAttachmentStatus,
  GoalCompletedSummary,
  GoalStatus,
  GoalStatusAttachment,
  GoalTerminalStatus,
} from './types.js'

export const GOAL_NO_PROMPT_PLACEHOLDER = '(no goal provided)'

export function getGoalPromptForState(args?: string): string {
  return args?.trim() || GOAL_NO_PROMPT_PLACEHOLDER
}

export function createActiveGoalStatus(
  id: string,
  prompt: string,
  setAt: number,
  tokensAtStart?: number,
): Extract<GoalStatus, { active: true }> {
  return {
    active: true,
    id,
    prompt,
    iterations: 0,
    setAt,
    ...(tokensAtStart === undefined ? {} : { tokensAtStart }),
  }
}

export function finishGoalStatus(
  activeGoal: Extract<GoalStatus, { active: true }>,
  status: GoalTerminalStatus,
  completedAt: number,
  currentTokens?: number,
  reason?: string,
): GoalStatus {
  const summary: GoalCompletedSummary = {
    id: activeGoal.id,
    prompt: activeGoal.prompt,
    status,
    completedAt,
    iterations: activeGoal.iterations,
    durationMs: completedAt - activeGoal.setAt,
    ...(activeGoal.tokensAtStart !== undefined && currentTokens !== undefined
      ? { tokens: Math.max(0, currentTokens - activeGoal.tokensAtStart) }
      : {}),
    ...(reason ? { reason } : {}),
  }
  return { active: false, lastCompleted: summary }
}

export function incrementGoalCheck(
  activeGoal: Extract<GoalStatus, { active: true }>,
  reason: string,
): GoalStatus {
  return {
    ...activeGoal,
    iterations: activeGoal.iterations + 1,
    lastReason: reason,
  }
}

export function formatGoalStatusText(goalStatus: GoalStatus): string {
  if (!goalStatus.active) return 'No goal set. Usage: /goal <condition>'
  const checkText =
    goalStatus.iterations === 0
      ? 'not yet evaluated'
      : `${goalStatus.iterations} ${goalStatus.iterations === 1 ? 'turn' : 'turns'}`
  const reasonText = goalStatus.lastReason
    ? `\nLast check: ${goalStatus.lastReason.trim()}`
    : ''
  return `Goal active: ${goalStatus.prompt} (${checkText})${reasonText}`
}

export function createGoalStatusAttachment(
  activeGoal: Extract<GoalStatus, { active: true }>,
  status: GoalAttachmentStatus,
  reason?: string,
): GoalStatusAttachment {
  return {
    type: 'goal_status',
    id: activeGoal.id,
    condition: activeGoal.prompt,
    status,
    sentinel: true,
    met: status === 'met' || status === 'cleared',
    failed: status === 'failed',
    iterations: activeGoal.iterations,
    ...(reason ? { reason } : {}),
  }
}
