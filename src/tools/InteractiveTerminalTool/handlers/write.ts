import type { z } from 'zod/v4'
import type { PtySessionManager } from '../../../utils/pty/PtySessionManager.ts'
import type { writeActionSchema } from '../actionSchemas.ts'

type WriteActionInput = z.infer<typeof writeActionSchema>

export function handleWrite(manager: PtySessionManager, input: WriteActionInput) {
  manager.write(input.sessionId, input.enter ? `${input.text}\r` : input.text)
  const status = manager.status(input.sessionId)

  return {
    sessionId: status.sessionId,
    accepted: true,
    isRunning: status.state === 'running',
  }
}
