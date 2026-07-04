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
      attachment.met !== true &&
      attachment.failed !== true
    ) {
      return attachment
    }
    return null
  }
  return null
}

export function restoreGoalFromTranscript(
  messages: Message[],
  setAppState: (updater: (prev: AppState) => AppState) => void,
  now: () => number = () => 0,
): void {
  const attachment = findGoalToRestore(messages)
  if (!attachment) {
    setAppState(prev =>
      prev.goalStatus.active ? { ...prev, goalStatus: { active: false } } : prev,
    )
    return
  }

  setAppState(prev => ({
    ...prev,
    goalStatus: {
      ...createActiveGoalStatus(attachment.id, attachment.condition, now()),
      iterations: attachment.iterations ?? 0,
      ...(attachment.reason ? { lastReason: attachment.reason } : {}),
    },
  }))
}
