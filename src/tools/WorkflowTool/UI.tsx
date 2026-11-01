import React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { StatusIcon } from '../../components/design-system/StatusIcon.js'
import { Text } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import { formatDuration, formatTokens } from '../../utils/format.js'
import { plural } from '../../utils/stringUtils.js'

// Official 2.1.311 renders the launched run's live state under the tool call.
export function renderToolResultMessage(output: string): React.ReactNode {
  const taskId = output.match(/Task ID: (\S+)/)?.[1]
  return taskId ? <WorkflowRunResult taskId={taskId} /> : null
}

function WorkflowRunResult({ taskId }: { taskId: string }): React.ReactNode {
  const task = useAppState(s => s.tasks[taskId])
  if (task?.type !== 'local_workflow') {
    return (
      <MessageResponse>
        <Text>
          <Text color="suggestion">/workflows</Text>
          <Text dimColor> to view dynamic workflow runs</Text>
        </Text>
      </MessageResponse>
    )
  }
  if (task.status === 'running' || task.status === 'pending') {
    return (
      <MessageResponse>
        <Text>
          <Text dimColor>Running in background · </Text>
          <Text color="suggestion">/workflows</Text>
          <Text dimColor> to monitor and save</Text>
        </Text>
      </MessageResponse>
    )
  }
  const stopped = task.status === 'failed' || task.status === 'killed'
  const label =
    task.status === 'failed'
      ? 'Failed'
      : task.status === 'killed'
        ? 'Stopped'
        : 'Completed'
  const duration =
    task.endTime && task.startTime
      ? ` in ${formatDuration(task.endTime - task.startTime)}`
      : ''
  const agents = task.agentCount ?? 0
  const tokens = task.tokenCount ?? 0
  return (
    <MessageResponse>
      <Text>
        <StatusIcon status={stopped ? 'error' : 'success'} withSpace />
        <Text dimColor>
          {label}
          {duration}
          {agents > 0 && ` · ${agents} ${plural(agents, 'agent')}`}
          {tokens > 0 && ` · ${formatTokens(tokens)} tokens`}
        </Text>
      </Text>
    </MessageResponse>
  )
}
