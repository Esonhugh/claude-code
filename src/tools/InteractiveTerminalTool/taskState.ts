import type { InteractiveTerminalTaskState } from '../../tasks/InteractiveTerminalTask.js'

type StatusSyncInput = {
  isRunning: boolean
  preview: string
  cols?: number
  rows?: number
}

export function syncInteractiveTerminalTaskAfterStatus(
  task: InteractiveTerminalTaskState,
  input: StatusSyncInput,
): InteractiveTerminalTaskState {
  const nextPreview = input.preview || task.preview

  return {
    ...task,
    cols: input.cols ?? task.cols,
    rows: input.rows ?? task.rows,
    preview: nextPreview,
    closed: !input.isRunning,
  }
}
