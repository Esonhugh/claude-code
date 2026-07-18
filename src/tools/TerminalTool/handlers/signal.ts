import type { z } from 'zod/v4'
import type { PtySessionManager } from '../../../utils/pty/PtySessionManager.js'
import type { sendSignalActionSchema } from '../actionSchemas.js'

type SignalActionInput = z.infer<typeof sendSignalActionSchema>

export function handleSignal(manager: PtySessionManager, input: SignalActionInput) {
  const status = manager.signal(input.target, input.signal)

  return {
    target: status.sessionId,
    accepted: true,
    isRunning: status.state === 'running',
  }
}
