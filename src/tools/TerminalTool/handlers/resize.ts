import type { z } from 'zod/v4'
import type { PtySessionManager } from '../../../utils/pty/PtySessionManager.js'
import type { resizePaneActionSchema } from '../actionSchemas.js'

type ResizeActionInput = z.infer<typeof resizePaneActionSchema>

export function handleResize(manager: PtySessionManager, input: ResizeActionInput) {
  const status = manager.resize(input.target, input.cols, input.rows)

  return {
    target: status.sessionId,
    cols: status.cols,
    rows: status.rows,
    isRunning: status.state === 'running',
  }
}
