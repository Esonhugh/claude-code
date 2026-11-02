import type { LocalCommandCall } from '../../types/command.js'
import { textOnlyCall } from '../textOnlyCall.js'
import { call as renameCall } from './rename.js'

export const call: LocalCommandCall = (args, context) =>
  textOnlyCall(onDone => renameCall(onDone, context as Parameters<typeof renameCall>[1], args))
