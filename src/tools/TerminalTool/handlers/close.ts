import type { z } from 'zod/v4'
import type { PtySessionManager } from '../../../utils/pty/PtySessionManager.js'
import type { killPaneActionSchema } from '../actionSchemas.js'

type CloseActionInput = z.infer<typeof killPaneActionSchema>

export function handleClose(manager: PtySessionManager, input: CloseActionInput) {
  const status = manager.close(input.target, input.force ?? false)

  return {
    target: status.sessionId,
    closed: true,
    exitCode: status.exitCode ?? 0,
  }
}
