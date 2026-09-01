import { randomUUID } from 'crypto'
import React, { useState } from 'react'
import { getSessionId, getTotalOutputTokens } from '../../bootstrap/state.js'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { StatusIcon } from '../../components/design-system/StatusIcon.js'
import { Box, Text, useInterval } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import { formatDuration, formatTokens } from '../../utils/format.js'
import { recordTranscript } from '../../utils/sessionStorage.js'
import {
  clearGoal,
  getGoalUnavailableMessage,
  registerGoalStopHook,
} from './hooks.js'
import { getGoalModePrompt } from './prompt.js'
import { createActiveGoalStatus, createGoalStatusAttachment } from './state.js'
import { GOAL_MAX_LENGTH, isGoalClear, isGoalTooLong } from './types.js'

function GoalRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}): React.ReactNode {
  return (
    <Box flexDirection="row">
      <Box flexShrink={0}>
        <Text dimColor>{label}: </Text>
      </Box>
      <Box flexGrow={1}>
        <Text wrap="wrap">{children}</Text>
      </Box>
    </Box>
  )
}

export function GoalStatusDialog({
  onDone,
}: {
  onDone: () => void
}): React.ReactNode {
  const goalStatus = useAppState((state) => state.goalStatus)
  const [, setFrame] = useState(0)
  useInterval(
    () => setFrame((frame) => frame + 1),
    goalStatus.active ? 1000 : null,
  )

  const dismissHint = (
    <ConfigurableShortcutHint
      action="confirm:no"
      context="Confirmation"
      fallback="Esc"
      description="dismiss"
    />
  )

  if (goalStatus.active) {
    const elapsed = formatDuration(Date.now() - goalStatus.setAt, {
      mostSignificantOnly: true,
    })
    const tokenCount = Math.max(
      0,
      getTotalOutputTokens() - (goalStatus.tokensAtStart ?? 0),
    )
    const turns =
      goalStatus.iterations > 0
        ? `${goalStatus.iterations} ${goalStatus.iterations === 1 ? 'turn' : 'turns'}`
        : null
    const subtitle = [
      `running ${elapsed}`,
      turns,
      `${formatTokens(tokenCount)} tokens`,
    ]
      .filter(Boolean)
      .join(' · ')

    return (
      <Dialog
        title="Goal active"
        subtitle={subtitle}
        onCancel={onDone}
        inputGuide={() => (
          <>
            <Text>/goal clear to stop early</Text>
            <Text dimColor> · </Text>
            {dismissHint}
          </>
        )}
      >
        <Box flexDirection="column">
          <GoalRow label="Goal">{goalStatus.prompt}</GoalRow>
          {goalStatus.lastReason && (
            <GoalRow label="Last check">{goalStatus.lastReason.trim()}</GoalRow>
          )}
        </Box>
      </Dialog>
    )
  }

  const completed =
    'lastCompleted' in goalStatus ? goalStatus.lastCompleted : undefined
  if (completed?.status === 'met') {
    const subtitle = [
      completed.durationMs === undefined
        ? null
        : formatDuration(completed.durationMs, {
            mostSignificantOnly: true,
          }),
      completed.iterations === undefined
        ? null
        : `${completed.iterations} ${completed.iterations === 1 ? 'turn' : 'turns'}`,
      completed.tokens === undefined
        ? null
        : `${formatTokens(completed.tokens)} tokens`,
    ]
      .filter(Boolean)
      .join(' · ')

    return (
      <Dialog
        title={
          <Text>
            <StatusIcon status="success" withSpace />
            Goal achieved
          </Text>
        }
        subtitle={subtitle}
        color="success"
        onCancel={onDone}
        inputGuide={() => (
          <>
            <Text>/goal &lt;condition&gt; to set another</Text>
            <Text dimColor> · </Text>
            {dismissHint}
          </>
        )}
      >
        <GoalRow label="Goal">{completed.prompt}</GoalRow>
      </Dialog>
    )
  }

  if (completed?.status === 'failed') {
    const subtitle = [
      completed.durationMs === undefined
        ? null
        : formatDuration(completed.durationMs, {
            mostSignificantOnly: true,
          }),
      completed.iterations === undefined
        ? null
        : `${completed.iterations} ${completed.iterations === 1 ? 'turn' : 'turns'}`,
      completed.tokens === undefined
        ? null
        : `${formatTokens(completed.tokens)} tokens`,
    ]
      .filter(Boolean)
      .join(' · ')

    return (
      <Dialog
        title={
          <Text>
            <StatusIcon status="error" withSpace />
            Goal could not be achieved
          </Text>
        }
        subtitle={subtitle}
        color="error"
        onCancel={onDone}
        inputGuide={() => (
          <>
            <Text>/goal &lt;condition&gt; to set another</Text>
            <Text dimColor> · </Text>
            {dismissHint}
          </>
        )}
      >
        <Box flexDirection="column">
          <GoalRow label="Goal">{completed.prompt}</GoalRow>
          {completed.reason && (
            <GoalRow label="Last check">{completed.reason.trim()}</GoalRow>
          )}
        </Box>
      </Dialog>
    )
  }

  return (
    <Dialog title="Goal" onCancel={onDone} inputGuide={() => dismissHint}>
      <Box flexDirection="column">
        <Text>No goal set</Text>
        <Text dimColor>/goal &lt;condition&gt; to set one</Text>
      </Box>
    </Dialog>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const prompt = args.trim()
  if (!prompt) {
    return (
      <GoalStatusDialog onDone={() => onDone(undefined, { display: 'skip' })} />
    )
  }

  if (isGoalClear(prompt)) {
    const { clearedGoal, attachment } = clearGoal(
      context.setAppState,
      getSessionId(),
    )
    onDone(clearedGoal ? `Goal cleared: ${clearedGoal}` : 'No goal set', {
      display: 'system',
      additionalMessages: attachment
        ? [createAttachmentMessage(attachment)]
        : undefined,
    })
    return null
  }

  if (isGoalTooLong(prompt)) {
    onDone(
      `Goal condition is limited to ${GOAL_MAX_LENGTH} characters (got ${prompt.length})`,
      { display: 'system' },
    )
    return null
  }

  const unavailableMessage = getGoalUnavailableMessage()
  if (unavailableMessage) {
    onDone(unavailableMessage, { display: 'system' })
    return null
  }

  const activeGoal = createActiveGoalStatus(
    randomUUID(),
    prompt,
    Date.now(),
    getTotalOutputTokens(),
  )
  const attachment = createGoalStatusAttachment(activeGoal, 'active')
  context.setAppState((prev) => ({ ...prev, goalStatus: activeGoal }))
  registerGoalStopHook({
    setAppState: context.setAppState,
    sessionId: getSessionId(),
    goalId: activeGoal.id,
    condition: prompt,
    appendGoalStatusAttachment: (completedAttachment) => {
      void recordTranscript([createAttachmentMessage(completedAttachment)])
    },
  })
  onDone(`Goal set: ${prompt}`, {
    shouldQuery: true,
    metaMessages: [getGoalModePrompt(prompt)],
    additionalMessages: [createAttachmentMessage(attachment)],
  })
  return null
}
