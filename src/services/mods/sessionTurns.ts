import type { Message } from '../../types/message.js'
import { isHumanTurn } from '../../utils/messagePredicates.js'

/** `$.session.turns`: human prompts, without virtual input or tool results that lack toolUseResult. */
export function countModSessionTurns(messages: readonly Message[]): number {
  return messages.filter(message =>
    isHumanTurn(message) &&
    !message.isVirtual &&
    (typeof message.message.content === 'string' ||
      !message.message.content.every(block => block.type === 'tool_result')),
  ).length
}
