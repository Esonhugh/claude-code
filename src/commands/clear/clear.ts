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
  // Saved once the session is left, so SDK hosts are not told the new one was renamed.
  const name = args.trim()
  const leftSessionId = getSessionId() as UUID
  const leftTranscriptPath = getTranscriptPath()
  await clearConversation({ ...context, resetUserMessageUuid: context.commandMessageUuid })
  if (name) {
    await saveCustomTitle(leftSessionId, name, leftTranscriptPath)
  }
  return { type: 'text', value: '' }
}
