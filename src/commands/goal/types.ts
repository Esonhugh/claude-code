export const GOAL_MAX_LENGTH = 4000
export const GOAL_HOOK_ID = 'builtin-goal-stop-hook'
export const GOAL_CLEAR_ALIASES = new Set([
  'clear',
  'stop',
  'off',
  'reset',
  'none',
  'cancel',
])

export type GoalTerminalStatus = 'met' | 'cleared' | 'failed'
export type GoalAttachmentStatus = 'active' | GoalTerminalStatus

export type GoalCompletedSummary = {
  id: string
  prompt: string
  status: GoalTerminalStatus
  completedAt: number
  iterations?: number
  durationMs?: number
  tokens?: number
  reason?: string
}

export type GoalStatus =
  | {
      active: false
      lastCompleted?: GoalCompletedSummary
    }
  | {
      active: true
      id: string
      prompt: string
      iterations: number
      setAt: number
      tokensAtStart?: number
      lastReason?: string
    }

export type GoalStatusAttachment = {
  type: 'goal_status'
  id: string
  condition: string
  status: GoalAttachmentStatus
  sentinel: true
  met?: boolean
  failed?: boolean
  iterations?: number
  durationMs?: number
  tokens?: number
  reason?: string
}

export function isGoalClear(args: string): boolean {
  return GOAL_CLEAR_ALIASES.has(args.trim().toLowerCase())
}

export function isGoalTooLong(args: string): boolean {
  return args.trim().length > GOAL_MAX_LENGTH
}

export function isGoalStatusAttachment(
  value: unknown,
): value is GoalStatusAttachment {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<GoalStatusAttachment>
  return (
    candidate.type === 'goal_status' &&
    candidate.sentinel === true &&
    typeof candidate.id === 'string' &&
    typeof candidate.condition === 'string' &&
    (candidate.status === 'active' ||
      candidate.status === 'met' ||
      candidate.status === 'cleared' ||
      candidate.status === 'failed')
  )
}
