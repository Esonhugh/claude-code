import type { TaskStateBase } from '../Task.js'
import type { Task } from '../Task.js'
import type { SetAppState } from '../Task.js'

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
