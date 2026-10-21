import type { z } from 'zod/v4'
import { keyToSequence } from '../../../utils/pty/keyMap.js'
import type { PtySessionManager } from '../../../utils/pty/PtySessionManager.js'
import type { sendKeysActionSchema } from '../actionSchemas.js'

type SendKeysActionInput = z.infer<typeof sendKeysActionSchema>

export function sendKeysSequence(
  input: Pick<SendKeysActionInput, 'text' | 'key' | 'enter'>,
): string {
  const text = input.text ?? ''
  const key = input.key ? keyToSequence(input.key) : ''
  const enter = input.enter ? '\r' : ''
  return `${text}${key}${enter}`
}

export function handleWrite(manager: PtySessionManager, input: SendKeysActionInput) {
  manager.write(input.target, sendKeysSequence(input))
  const status = manager.status(input.target)

  return {
    target: status.sessionId,
    accepted: true,
    isRunning: status.state === 'running',
  }
}
