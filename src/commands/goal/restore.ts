import type { AppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'
import { createActiveGoalStatus } from './state.js'
import {
  isGoalStatusAttachment,
  type GoalStatusAttachment,
} from './types.js'

export function findGoalToRestore(
  messages: Message[],
): GoalStatusAttachment | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.type !== 'attachment') continue
    const attachment = message.attachment
    if (!isGoalStatusAttachment(attachment)) continue
    if (
      attachment.status === 'active' &&
      (attachment.met === true || attachment.failed === true)
    ) {
      return null
    }
    return attachment
  }
  return null
}

export function applyGoalStatusAttachment(
  attachment: GoalStatusAttachment,
  setAppState: (updater: (prev: AppState) => AppState) => void,
  now: () => number = Date.now,
  { hydrateTerminal = false }: { hydrateTerminal?: boolean } = {},
): void {
  setAppState(prev => {
    if (attachment.status === 'active') {
      if (attachment.met === true || attachment.failed === true) return prev
      const iterations = attachment.iterations ?? 0
      const lastReason = attachment.reason
      if (
        prev.goalStatus.active &&
        prev.goalStatus.id === attachment.id &&
        prev.goalStatus.prompt === attachment.condition &&
        prev.goalStatus.iterations === iterations &&
        prev.goalStatus.lastReason === lastReason
      ) {
        return prev
      }
      return {
        ...prev,
        goalStatus: {
          ...createActiveGoalStatus(
            attachment.id,
            attachment.condition,
            prev.goalStatus.active && prev.goalStatus.id === attachment.id
              ? prev.goalStatus.setAt
              : (attachment.setAt ?? now()),
            prev.goalStatus.active && prev.goalStatus.id === attachment.id
              ? prev.goalStatus.tokensAtStart
              : attachment.tokensAtStart,
          ),
          iterations,
          ...(lastReason ? { lastReason } : {}),
        },
      }
    }

    if (
      !hydrateTerminal &&
      (!prev.goalStatus.active || prev.goalStatus.id !== attachment.id)
    ) {
      return prev
    }

    return {
      ...prev,
      goalStatus: {
        active: false,
        lastCompleted: {
          id: attachment.id,
          prompt: attachment.condition,
          status: attachment.status,
          completedAt: now(),
          ...(attachment.iterations === undefined
            ? {}
            : { iterations: attachment.iterations }),
          ...(attachment.durationMs === undefined
            ? {}
            : { durationMs: attachment.durationMs }),
          ...(attachment.tokens === undefined
            ? {}
            : { tokens: attachment.tokens }),
          ...(attachment.reason ? { reason: attachment.reason } : {}),
        },
      },
    }
  })
}

export function restoreGoalFromTranscript(
  messages: Message[],
  setAppState: (updater: (prev: AppState) => AppState) => void,
  now: () => number = () => 0,
  tokensAtStartOverride?: number,
): void {
  const attachment = findGoalToRestore(messages)
  if (!attachment) {
    setAppState(prev =>
      prev.goalStatus.active ? { ...prev, goalStatus: { active: false } } : prev,
    )
    return
  }

  if (attachment.status !== 'active') {
    applyGoalStatusAttachment(attachment, setAppState, now, {
      hydrateTerminal: true,
    })
    return
  }

  setAppState(prev => ({
    ...prev,
    goalStatus: {
      ...createActiveGoalStatus(
        attachment.id,
        attachment.condition,
        attachment.setAt ?? now(),
        tokensAtStartOverride ?? attachment.tokensAtStart,
      ),
      iterations: attachment.iterations ?? 0,
      ...(attachment.reason ? { lastReason: attachment.reason } : {}),
    },
  }))
}
