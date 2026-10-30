import { isTerminalTaskStatus } from '../Task.js'
import type { QueuedCommand } from '../types/textInputTypes.js'
import { isLocalAgentTask } from './LocalAgentTask/LocalAgentTask.js'
import type { TaskState } from './types.js'

// Official 2.1.311: background agents and workflows the main turn still owes a
// report from — running, finished but unreported, or with a queued notification.
export function countPendingBackgroundWork({
  tasks,
  queuedCommands = [],
}: {
  tasks: Record<string, TaskState>
  queuedCommands?: readonly QueuedCommand[]
}): { pendingAgents: number; pendingWorkflows: number } {
  const agents = new Set<string>()
  const workflows = new Set<string>()
  const add = (task: TaskState) => {
    if (isLocalAgentTask(task) && task.isBackgrounded && !task.awaitedByCaller) agents.add(task.id)
    else if (task.type === 'local_workflow') workflows.add(task.id)
  }
  for (const task of Object.values(tasks)) {
    if (task.status === 'running' || (isTerminalTaskStatus(task.status) && !task.notified)) add(task)
  }
  for (const command of queuedCommands) {
    if (command.mode !== 'task-notification' || command.agentId !== undefined || command.taskId === undefined) continue
    const task = tasks[command.taskId]
    if (task) add(task)
  }
  return { pendingAgents: agents.size, pendingWorkflows: workflows.size }
}

/**
 * A turn that ends while background work is pending records the count and
 * starts a wait; the first turn after the wait reports the time since the
 * waiting turn started.
 */
export function turnDurationAfterBackgroundWait({
  tasks,
  queuedCommands,
  turnDurationMs,
  turnStartTime,
  now,
  backgroundWaitStartTime,
}: {
  tasks: Record<string, TaskState>
  queuedCommands?: readonly QueuedCommand[]
  turnDurationMs: number
  turnStartTime: number
  now: number
  backgroundWaitStartTime: number | null
}): {
  durationMs: number
  pendingBackgroundAgentCount?: number
  pendingWorkflowCount?: number
  backgroundWaitStartTime: number | null
} {
  const { pendingAgents, pendingWorkflows } = countPendingBackgroundWork({ tasks, queuedCommands })
  if (pendingAgents > 0 || pendingWorkflows > 0) {
    return {
      durationMs: turnDurationMs,
      pendingBackgroundAgentCount: pendingAgents > 0 ? pendingAgents : undefined,
      pendingWorkflowCount: pendingWorkflows > 0 ? pendingWorkflows : undefined,
      backgroundWaitStartTime: backgroundWaitStartTime ?? turnStartTime,
    }
  }
  return {
    durationMs: backgroundWaitStartTime !== null ? now - backgroundWaitStartTime : turnDurationMs,
    backgroundWaitStartTime: null,
  }
}
