import type { z } from 'zod/v4'
import type { PtySessionManager } from '../../../utils/pty/PtySessionManager.ts'
import type { signalActionSchema } from '../actionSchemas.ts'

type SignalActionInput = z.infer<typeof signalActionSchema>

export function handleSignal(manager: PtySessionManager, input: SignalActionInput) {
  const status = manager.signal(input.sessionId, input.signal)

  return {
    sessionId: status.sessionId,
    accepted: true,
    isRunning: status.state === 'running',
  }
}
