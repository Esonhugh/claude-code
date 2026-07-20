import type { TerminalTaskState } from '../../tasks/TerminalTask.js'

type StatusSyncInput = {
  isRunning: boolean
  preview: string
  cols?: number
  rows?: number
}

export function syncTerminalTaskAfterStatus(
  task: TerminalTaskState,
  input: StatusSyncInput,
): TerminalTaskState {
  const nextPreview = input.preview || task.preview
  const isClosed = !input.isRunning

  return {
    ...task,
    cols: input.cols ?? task.cols,
    rows: input.rows ?? task.rows,
    preview: nextPreview,
    closed: isClosed,
    status: isClosed ? 'completed' : task.status,
    endTime: isClosed ? task.endTime ?? Date.now() : task.endTime,
  }
}
