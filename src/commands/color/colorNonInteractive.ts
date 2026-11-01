import type { LocalCommandCall } from '../../types/command.js'
import { textOnlyCall } from '../textOnlyCall.js'
import { call as colorCall } from './color.js'

export const call: LocalCommandCall = (args, context) =>
  textOnlyCall(onDone => colorCall(onDone, context as Parameters<typeof colorCall>[1], args))
