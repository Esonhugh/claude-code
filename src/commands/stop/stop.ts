import { hostRequest } from '../../daemon/protocol.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { errorMessage } from '../../utils/errors.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'

export const call: LocalJSXCommandCall = async onDone => {
  const sock = process.env.CLAUDE_PTY_SOCK
  onDone('Stopping this background session…', { display: 'system' })
  try {
    // The PTY host records the session as stopped and ends this process.
    if (sock) {
      const response = await hostRequest(sock, { type: 'stop' }, 10_000)
      if (response.ok) return null
    }
  } catch (error) {
    onDone(`Could not reach the background service: ${errorMessage(error)}`, { display: 'system' })
  }
  await gracefulShutdown(0, 'other')
  return null
}
