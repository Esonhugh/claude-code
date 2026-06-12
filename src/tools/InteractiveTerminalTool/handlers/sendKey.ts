import type { z } from 'zod/v4'
import { keyToSequence } from '../../../utils/pty/keyMap.ts'
import type { PtySessionManager } from '../../../utils/pty/PtySessionManager.ts'
import type { sendKeyActionSchema } from '../actionSchemas.ts'

type SendKeyActionInput = z.infer<typeof sendKeyActionSchema>

export function handleSendKey(manager: PtySessionManager, input: SendKeyActionInput) {
  manager.write(input.sessionId, keyToSequence(input.key))
  const status = manager.status(input.sessionId)

  return {
    sessionId: status.sessionId,
    accepted: true,
    isRunning: status.state === 'running',
  }
}
