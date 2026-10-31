import type { LocalCommandCall } from '../../types/command.js'
import { prefetchFastModeStatus } from '../../utils/fastMode.js'
import { handleFastModeShortcut } from './fast.js'

export const call: LocalCommandCall = async (args, context) => {
  await prefetchFastModeStatus()
  const arg = args.trim().toLowerCase()
  if (arg === 'on' || arg === 'off') {
    return {
      type: 'text',
      value: await handleFastModeShortcut(
        arg === 'on',
        context.getAppState,
        context.setAppState,
      ),
    }
  }
  return {
    type: 'text',
    value: `Fast mode is ${context.getAppState().fastMode ? 'ON' : 'OFF'}. Usage: /fast [on|off]`,
  }
}
