import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TASK_TYPE_TAG,
  TOOL_USE_ID_TAG,
} from '../constants/xml.js'
import type { TaskStateBase } from '../Task.js'
import type { Task } from '../Task.js'
import type { SetAppState } from '../Task.js'
import { enqueuePendingNotification } from '../utils/messageQueueManager.js'
import { updateTaskState } from '../utils/task/framework.js'
import { escapeXml } from '../utils/xml.js'

export type TerminalTaskState = TaskStateBase & {
  type: 'interactive_terminal'
  sessionId: string
  command: string
  cwd: string
  cols: number
  rows: number
  preview: string
  closed: boolean
}

export function isTerminalTask(
  task: unknown,
): task is TerminalTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'interactive_terminal'
  )
}

type TerminalTaskRuntimeKiller = (
  task: TerminalTaskState,
  setAppState: SetAppState,
) => void | Promise<void>

let runtimeKiller: TerminalTaskRuntimeKiller | undefined

export function registerTerminalTaskRuntimeKiller(
  killer: TerminalTaskRuntimeKiller,
): void {
  runtimeKiller = killer
}

export function enqueueTerminalTaskNotification(
  taskId: string,
  setAppState: SetAppState,
): void {
  let taskToNotify: TerminalTaskState | undefined
  updateTaskState<TerminalTaskState>(taskId, setAppState, task => {
    if (task.notified || task.status === 'pending' || task.status === 'running') {
      return task
    }
    taskToNotify = task
    return { ...task, notified: true }
  })

  if (!taskToNotify) {
    return
  }

  const task = taskToNotify
  const toolUseIdLine = task.toolUseId
    ? `\n<${TOOL_USE_ID_TAG}>${task.toolUseId}</${TOOL_USE_ID_TAG}>`
    : ''
  const summary =
    task.status === 'completed'
      ? `${task.description} completed`
      : task.status === 'failed'
        ? `${task.description} failed`
        : `${task.description} was stopped`
  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${task.id}</${TASK_ID_TAG}>${toolUseIdLine}
<${TASK_TYPE_TAG}>${task.type}</${TASK_TYPE_TAG}>
<${OUTPUT_FILE_TAG}>${task.outputFile}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${task.status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${escapeXml(summary)}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`

  enqueuePendingNotification({
    value: message,
    mode: 'task-notification',
  })
}

export const TerminalTask: Task = {
  name: 'TerminalTask',
  type: 'interactive_terminal',
  async kill(taskId: string, setAppState: SetAppState) {
    let targetTask: TerminalTaskState | undefined
    setAppState(prev => {
      const task = prev.tasks[taskId]
      if (!isTerminalTask(task)) {
        return prev
      }
      targetTask = task
      return prev
    })

    if (targetTask && runtimeKiller) {
      await runtimeKiller(targetTask, setAppState)
      return
    }

    setAppState(prev => {
      const task = prev.tasks[taskId]
      if (!isTerminalTask(task)) {
        return prev
      }
      return {
        ...prev,
        tasks: {
          ...prev.tasks,
          [taskId]: {
            ...task,
            status: 'killed',
            closed: true,
            notified: true,
            endTime: Date.now(),
          },
        },
      }
    })
  },
}
