/**
 * CoordinatorTaskPanel — steerable list of sessions and background work.
 *
 * Renders below the prompt input footer whenever local_agent or local_workflow
 * tasks have visible rows. Enter switches to main/agent context or opens the
 * workflow detail dialog; x handling lives in PromptInput keyboard bindings.
 */

import figures from 'figures'
import * as React from 'react'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Box, Text } from '../ink.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import {
  enterTeammateView,
  exitTeammateView,
} from '../state/teammateViewHelpers.js'
import { isPanelAgentTask } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import { evictTerminalTask } from '../utils/task/framework.js'
import {
  type CoordinatorSessionRow,
  getCoordinatorSessionRows,
  getVisibleAgentTasks,
} from './CoordinatorAgentStatusRows.js'

export { getCoordinatorSessionRows, getVisibleAgentTasks }
export type { CoordinatorPanelTask, CoordinatorSessionRow } from './CoordinatorAgentStatusRows.js'

export function CoordinatorTaskPanel({
  onOpenTasksDialog,
}: {
  onOpenTasksDialog?: (taskId?: string) => void
}): React.ReactNode {
  const tasks = useAppState(s => s.tasks)
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  const agentNameRegistry = useAppState(s => s.agentNameRegistry)
  const coordinatorTaskIndex = useAppState(s => s.coordinatorTaskIndex)
  const tasksSelected = useAppState(s => s.footerSelection === 'tasks')
  const selectedIndex = tasksSelected ? coordinatorTaskIndex : undefined
  const setAppState = useSetAppState()

  const visibleTasks = getVisibleAgentTasks(tasks)
  const hasAgentTasks = visibleTasks.some(task => task.type === 'local_agent')

  // 1s tick: re-render for elapsed time + evict local agents past their
  // deadline. Workflows stay visible through their task lifecycle.
  const tasksRef = React.useRef(tasks)
  tasksRef.current = tasks
  const [, setTick] = React.useState(0)
  React.useEffect(() => {
    if (!hasAgentTasks) return
    const interval = setInterval(
      (tasksRef, setAppState, setTick) => {
        const now = Date.now()
        for (const t of Object.values(tasksRef.current)) {
          if (isPanelAgentTask(t) && (t.evictAfter ?? Infinity) <= now) {
            evictTerminalTask(t.id, setAppState)
          }
        }
        setTick((prev: number) => prev + 1)
      },
      1000,
      tasksRef,
      setAppState,
      setTick,
    )
    return () => clearInterval(interval)
  }, [hasAgentTasks, setAppState])

  const nameByAgentId = React.useMemo(() => {
    const inv = new Map<string, string>()
    for (const [n, id] of agentNameRegistry) inv.set(id, n)
    return inv
  }, [agentNameRegistry])

  if (visibleTasks.length === 0) {
    return null
  }

  const rows = getCoordinatorSessionRows({
    tasks,
    selectedIndex,
    viewingAgentTaskId,
    nameByAgentId,
  })

  return (
    <Box flexDirection="column" marginTop={1} paddingX={2}>
      <Text dimColor>Sessions / background work</Text>
      {rows.map(row => (
        <SessionRow
          key={row.id}
          row={row}
          onClick={() => {
            if (row.kind === 'main') {
              exitTeammateView(setAppState)
            } else if (row.kind === 'agent' && row.taskId) {
              enterTeammateView(row.taskId, setAppState)
            } else if (row.kind === 'workflow' && row.taskId) {
              onOpenTasksDialog?.(row.taskId)
            }
          }}
        />
      ))}
    </Box>
  )
}

/**
 * Returns the number of visible coordinator rows including main.
 * Shared with PromptInput navigation bounds.
 */
export function useCoordinatorTaskCount(): number {
  const tasks = useAppState(s => s.tasks)
  return React.useMemo(() => {
    const count = getVisibleAgentTasks(tasks).length
    return count > 0 ? count + 1 : 0
  }, [tasks])
}

function SessionRow({
  row,
  onClick,
}: {
  row: CoordinatorSessionRow
  onClick: () => void
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const [hover, setHover] = React.useState(false)
  const active = row.selected || hover
  const prefix = active ? `${figures.pointer} ` : '  '
  const maxLabelWidth = Math.max(12, Math.min(36, columns - 46))
  const label = row.label.length > maxLabelWidth
    ? `${row.label.slice(0, Math.max(0, maxLabelWidth - 1))}…`
    : row.label.padEnd(maxLabelWidth)
  const meta = row.meta ? ` ${row.meta}` : ''
  const status = row.statusText ? ` ${row.statusText}` : ''
  return (
    <Box
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Text dimColor={!active && !row.viewed} bold={row.viewed || active}>
        {prefix}
        {row.icon} {label}
        {meta}
        {status}
      </Text>
    </Box>
  )
}
