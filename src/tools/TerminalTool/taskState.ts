import type {
  TerminalTaskState,
  TerminalTerminationReason,
} from '../../tasks/TerminalTask.js'
import type {
  PtyDriverSessionStatus,
  TerminalSessionRecord,
} from '../../utils/pty/types.js'

type StatusSyncInput = {
  status: PtyDriverSessionStatus &
    Partial<Pick<TerminalSessionRecord, 'cols' | 'rows'>>
  preview: string
  terminationReason?: TerminalTerminationReason
  error?: string
}

export function syncTerminalTaskAfterStatus(
  task: TerminalTaskState,
  input: StatusSyncInput,
): TerminalTaskState {
  if (task.status !== 'running') {
    return task
  }

  const nextPreview = input.preview || task.preview
  const nextCols = input.status.cols ?? task.cols
  const nextRows = input.status.rows ?? task.rows
  const isRunning =
    input.status.state === 'running' || input.status.state === 'starting'

  if (isRunning && !input.error) {
    if (
      nextCols === task.cols &&
      nextRows === task.rows &&
      nextPreview === task.preview
    ) {
      return task
    }
    return {
      ...task,
      cols: nextCols,
      rows: nextRows,
      preview: nextPreview,
    }
  }

  const terminationReason = input.error
    ? 'driver-error'
    : input.terminationReason
  const status =
    terminationReason === 'signal' ||
    terminationReason === 'kill-pane' ||
    terminationReason === 'task-stop'
      ? 'killed'
      : input.status.state === 'failed' ||
          (input.status.exitCode !== undefined &&
            input.status.exitCode !== null &&
            input.status.exitCode !== 0)
        ? 'failed'
        : 'completed'

  return {
    ...task,
    cols: nextCols,
    rows: nextRows,
    preview: nextPreview,
    closed: true,
    status,
    exitCode: input.status.exitCode,
    signal: input.status.signal,
    terminationReason,
    terminalError: input.error,
    endTime: task.endTime ?? Date.now(),
  }
}
