import type { UUID } from 'crypto'
import { getSessionId } from '../../bootstrap/state.js'
import type { LocalCommandCall } from '../../types/command.js'
import {
  getTranscriptPath,
  saveCustomTitle,
} from '../../utils/sessionStorage.js'
import { clearConversation } from './conversation.js'

export const call: LocalCommandCall = async (args, context) => {
  // 2.1.311: `/clear <name>` names the session being left, so /resume finds it.
  const name = args.trim()
  if (name) {
    await saveCustomTitle(getSessionId() as UUID, name, getTranscriptPath())
  }
  await clearConversation(context)
  return { type: 'text', value: '' }
}
