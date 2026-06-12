import type { TaskStateBase } from '../Task.js'
import type { Task } from '../Task.js'
import type { SetAppState } from '../Task.js'

export type InteractiveTerminalTaskState = TaskStateBase & {
  type: 'interactive_terminal'
  sessionId: string
  command: string
  cwd: string
  preview: string
  previewUpdatedAt?: number
  closed: boolean
}

export function isInteractiveTerminalTask(
  task: unknown,
): task is InteractiveTerminalTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'interactive_terminal'
  )
}

export const InteractiveTerminalTask: Task = {
  name: 'InteractiveTerminalTask',
  type: 'interactive_terminal',
  async kill(taskId: string, setAppState: SetAppState) {
    setAppState(prev => {
      const task = prev.tasks[taskId]
      if (!isInteractiveTerminalTask(task)) {
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
            endTime: Date.now(),
          },
        },
      }
    })
  },
}
