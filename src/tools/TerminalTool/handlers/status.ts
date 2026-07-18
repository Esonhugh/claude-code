import type { z } from 'zod/v4'
import type { PtySessionManager } from '../../../utils/pty/PtySessionManager.js'
import type { displayMessageActionSchema } from '../actionSchemas.js'

type StatusActionInput = z.infer<typeof displayMessageActionSchema>

export function handleStatus(manager: PtySessionManager, input: StatusActionInput) {
  const status = manager.status(input.target)

  return {
    target: status.sessionId,
    pid: status.pid ?? null,
    isRunning: status.state === 'running',
    exitCode: status.exitCode ?? null,
    cols: status.cols,
    rows: status.rows,
    bufferCursor: status.nextCursor,
    startedAt: status.startedAt,
    lastActivityAt: status.lastActivityAt,
  }
}
