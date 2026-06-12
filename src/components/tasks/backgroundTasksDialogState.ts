import {
  type TaskState,
  isBackgroundTask,
} from '../../tasks/types.js'

export type BackgroundTasksDialogScope = 'all' | 'interactive-terminal'

export type BackgroundTasksDialogViewState =
  | { mode: 'list' }
  | { mode: 'detail'; itemId: string }

export function getScopedBackgroundTasks(
  tasks: Record<string, TaskState> | undefined,
  foregroundedTaskId: string | undefined,
  scope: BackgroundTasksDialogScope = 'all',
): TaskState[] {
  const backgroundTasks = Object.values(tasks ?? {}).filter(
    task =>
      isBackgroundTask(task) &&
      task.type !== 'local_workflow' &&
      !(task.type === 'local_agent' && task.id === foregroundedTaskId),
  )

  if (scope === 'interactive-terminal') {
    return backgroundTasks.filter(task => task.type === 'interactive_terminal')
  }

  return backgroundTasks
}

export function getBackgroundTasksDialogInitialState({
  tasks,
  foregroundedTaskId,
  initialDetailTaskId,
  scope = 'all',
}: {
  tasks: Record<string, TaskState> | undefined
  foregroundedTaskId?: string
  initialDetailTaskId?: string
  scope?: BackgroundTasksDialogScope
}): {
  viewState: BackgroundTasksDialogViewState
  skippedListOnMount: boolean
  initialSelectedIndex: number
} {
  if (initialDetailTaskId) {
    return {
      viewState: { mode: 'detail', itemId: initialDetailTaskId },
      skippedListOnMount: true,
      initialSelectedIndex: 0,
    }
  }

  const scopedTasks = getScopedBackgroundTasks(tasks, foregroundedTaskId, scope)

  if (scopedTasks.length === 1) {
    return {
      viewState: { mode: 'detail', itemId: scopedTasks[0]!.id },
      skippedListOnMount: true,
      initialSelectedIndex: 0,
    }
  }

  return {
    viewState: { mode: 'list' },
    skippedListOnMount: false,
    initialSelectedIndex: 0,
  }
}
