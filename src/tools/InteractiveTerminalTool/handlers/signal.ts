import type { z } from 'zod/v4'
import type { PtySessionManager } from '../../../utils/pty/PtySessionManager.js'
import type { signalActionSchema } from '../actionSchemas.js'

type SignalActionInput = z.infer<typeof signalActionSchema>

export function handleSignal(manager: PtySessionManager, input: SignalActionInput) {
  const status = manager.signal(input.sessionId, input.signal)

  return {
    sessionId: status.sessionId,
    accepted: true,
    isRunning: status.state === 'running',
  }
}
