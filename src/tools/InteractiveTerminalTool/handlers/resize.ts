import type { z } from 'zod/v4'
import type { PtySessionManager } from '../../../utils/pty/PtySessionManager.js'
import type { resizeActionSchema } from '../actionSchemas.js'

type ResizeActionInput = z.infer<typeof resizeActionSchema>

export function handleResize(manager: PtySessionManager, input: ResizeActionInput) {
  const status = manager.resize(input.sessionId, input.cols, input.rows)

  return {
    sessionId: status.sessionId,
    cols: status.cols,
    rows: status.rows,
    isRunning: status.state === 'running',
  }
}
