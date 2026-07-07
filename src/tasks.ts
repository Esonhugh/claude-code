import { feature } from 'bun:bundle'
import type { Task, TaskType } from './Task.js'
import { DreamTask } from './tasks/DreamTask/DreamTask.js'
import { InteractiveTerminalTask } from './tasks/InteractiveTerminalTask.js'
import { LocalAgentTask } from './tasks/LocalAgentTask/LocalAgentTask.js'
import { LocalShellTask } from './tasks/LocalShellTask/LocalShellTask.js'
import { RemoteAgentTask } from './tasks/RemoteAgentTask/RemoteAgentTask.js'

function getLocalWorkflowTask(): Task {
  // Lazy require avoids evaluating LocalWorkflowTask while tasks.ts itself is
  // being imported through task-stop/tool initialization paths.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./tasks/LocalWorkflowTask/LocalWorkflowTask.js').LocalWorkflowTask
}

function getMonitorMcpTask(): Task | null {
  if (!feature('MONITOR_TOOL')) return null
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./tasks/MonitorMcpTask/MonitorMcpTask.js').MonitorMcpTask
}

/**
 * Get all tasks.
 * Mirrors the pattern from tools.ts
 * Note: Returns array inline to avoid circular dependency issues with top-level const
 */
export function getAllTasks(): Task[] {
  const tasks: Task[] = [
    LocalShellTask,
    InteractiveTerminalTask,
    LocalAgentTask,
    RemoteAgentTask,
    DreamTask,
  ]
  tasks.push(getLocalWorkflowTask())
  const monitorMcpTask = getMonitorMcpTask()
  if (monitorMcpTask) tasks.push(monitorMcpTask)
  return tasks
}

/**
 * Get a task by its type.
 */
export function getTaskByType(type: TaskType): Task | undefined {
  return getAllTasks().find(t => t.type === type)
}
