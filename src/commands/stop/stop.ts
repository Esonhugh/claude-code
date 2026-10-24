import { daemonRequest } from '../../daemon/protocol.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { errorMessage } from '../../utils/errors.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'

export const call: LocalJSXCommandCall = async onDone => {
  const id = process.env.CLAUDE_JOB_ID
  onDone('Stopping this background session…', { display: 'system' })
  try {
    // The supervisor records the session as stopped and ends this process.
    if (id) {
      const response = await daemonRequest({ type: 'stop', id }, 10_000)
      if (response.ok) return null
    }
  } catch (error) {
    onDone(`Could not reach the background service: ${errorMessage(error)}`, { display: 'system' })
  }
  await gracefulShutdown(0, 'other')
  return null
}
