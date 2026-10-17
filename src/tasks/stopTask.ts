// Shared logic for stopping a running task.
// Used by TaskStopTool (LLM-invoked) and SDK stop_task control request.

import type { AppState } from '../state/AppState.js'
import type { TaskStateBase } from '../Task.js'
import { getTaskByType } from '../tasks.js'
import { isLocalShellTask } from './LocalShellTask/guards.js'
import { isLiveLocalAgentTask, isLocalAgentTask, killAsyncAgent } from './LocalAgentTask/LocalAgentTask.js'
import { readAgentMetadata } from '../utils/sessionStorage.js'
import { asAgentId } from '../types/ids.js'

export class StopTaskError extends Error {
  constructor(
    message: string,
    public readonly code: 'not_found' | 'not_running' | 'unsupported_type',
  ) {
    super(message)
    this.name = 'StopTaskError'
  }
}

type StopTaskContext = {
  source?: 'model' | 'user'
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
}

type StopTaskResult = {
  taskId: string
  taskType: string
  command: string | undefined
}

/**
 * Look up a task by ID, validate it is running, kill it, and mark it as notified.
 *
 * Throws {@link StopTaskError} when the task cannot be stopped (not found,
 * not running, or unsupported type). Callers can inspect `error.code` to
 * distinguish the failure reason.
 */
export async function stopTask(
  taskId: string,
  context: StopTaskContext,
): Promise<StopTaskResult> {
  const { getAppState, setAppState } = context
  const appState = getAppState()
  const task = appState.tasks?.[taskId] as TaskStateBase | undefined

  if (!task) {
    throw new StopTaskError(`No task found with ID: ${taskId}`, 'not_found')
  }

  if (task.status !== 'running' && !isLiveLocalAgentTask(task)) {
    throw new StopTaskError(
      `Task ${taskId} is not running (status: ${task.status})`,
      'not_running',
    )
  }

  const taskImpl = getTaskByType(task.type)
  if (!taskImpl) {
    throw new StopTaskError(
      `Unsupported task type: ${task.type}`,
      'unsupported_type',
    )
  }

  if (context.source === 'user' && isLocalAgentTask(task)) {
    killAsyncAgent(taskId, setAppState, 'user')
    // Ensure the SDK acknowledgment follows durable cancellation.
    await readAgentMetadata(asAgentId(taskId))
  } else {
    await taskImpl.kill(taskId, setAppState)
  }

  // Bash: killTask pre-sets notified (suppresses the "exit code 137" noise)
  // and emits the SDK 'stopped' event itself. Agent tasks: don't suppress —
  // the AbortError catch sends a notification carrying
  // extractPartialResult(agentMessages), which is the payload not noise.

  const command = isLocalShellTask(task) ? task.command : task.description

  return { taskId, taskType: task.type, command }
}
