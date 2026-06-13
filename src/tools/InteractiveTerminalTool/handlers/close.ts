import type { z } from 'zod/v4'
import type { PtySessionManager } from '../../../utils/pty/PtySessionManager.js'
import type { closeActionSchema } from '../actionSchemas.js'

type CloseActionInput = z.infer<typeof closeActionSchema>

export function handleClose(manager: PtySessionManager, input: CloseActionInput) {
  const status = manager.close(input.sessionId, input.force ?? false)

  return {
    sessionId: status.sessionId,
    closed: true,
    exitCode: status.exitCode ?? 0,
  }
}
