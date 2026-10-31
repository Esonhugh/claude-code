import type { LocalCommandCall } from '../../types/command.js'
import { textOnlyCall } from '../textOnlyCall.js'
import { call as configCall } from './config.js'

export const call: LocalCommandCall = async (args, context) => {
  if (!args.trim()) {
    return { type: 'text', value: 'Usage: /config key=value' }
  }
  return textOnlyCall(onDone => configCall(onDone, context, args))
}
