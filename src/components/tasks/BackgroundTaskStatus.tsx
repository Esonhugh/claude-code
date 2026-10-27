import figures from 'figures'
import * as React from 'react'
import { useMemo, useState } from 'react'
import { useAppState } from 'src/state/AppState.js'
import { isPanelAgentTask } from 'src/tasks/LocalAgentTask/LocalAgentTask.js'
import { getPillLabel, pillNeedsCta } from 'src/tasks/pillLabel.js'
import {
  isBackgroundTask,
  type TaskState,
} from 'src/tasks/types.js'
import { Box, Text } from '../../ink.js'
import { isAnt } from 'src/utils/userType.js'


type Props = {
  tasksSelected: boolean
  onOpenDialog?: (taskId?: string) => void
}

// In-process teammates are rows in the agent panel, not part of this pill.
export function BackgroundTaskStatus({
  tasksSelected,
  onOpenDialog,
}: Props): React.ReactNode {
  const tasks = useAppState(s => s.tasks)

  const runningTasks = useMemo(
    () =>
      (Object.values(tasks ?? {}) as TaskState[]).filter(
        t =>
          isBackgroundTask(t) &&
          t.type !== 'in_process_teammate' &&
          t.type !== 'local_workflow' &&
          !(isAnt() && isPanelAgentTask(t)),
      ),
    [tasks],
  )

  if (runningTasks.length === 0) {
    return null
  }

  return (
    <>
      <SummaryPill selected={tasksSelected} onClick={onOpenDialog}>
        {getPillLabel(runningTasks)}
      </SummaryPill>
      {pillNeedsCta(runningTasks) && (
        <Text dimColor> · {figures.arrowDown} to view</Text>
      )}
    </>
  )
}

function SummaryPill({
  selected,
  onClick,
  children,
}: {
  selected: boolean
  onClick?: () => void
  children: React.ReactNode
}): React.ReactNode {
  const [hover, setHover] = useState(false)
  const label = (
    <Text color="background" inverse={selected || hover}>
      {children}
    </Text>
  )
  if (!onClick) return label
  return (
    <Box
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {label}
    </Box>
  )
}
