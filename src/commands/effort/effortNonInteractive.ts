import type { LocalCommandCall } from '../../types/command.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { EFFORT_HELP, executeEffort, showCurrentEffort } from './effort.js'

export const call: LocalCommandCall = async (args, context) => {
  const value = args.trim()
  if (['help', '-h', '--help'].includes(value)) {
    return { type: 'text', value: EFFORT_HELP }
  }
  if (!value || value === 'current' || value === 'status') {
    const { message } = showCurrentEffort(
      context.getAppState().effortValue,
      getMainLoopModel(),
    )
    return { type: 'text', value: message }
  }
  const { message, effortUpdate } = executeEffort(value)
  if (effortUpdate) {
    context.setAppState(prev => ({ ...prev, effortValue: effortUpdate.value }))
  }
  return { type: 'text', value: message }
}
