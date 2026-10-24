import type { Message, UserMessage } from '../types/message.js'
import { INTERRUPT_MESSAGE, INTERRUPT_MESSAGE_FOR_TOOL_USE } from './messages.js'
import { validateUuid } from './uuid.js'

export const RESUME_DROPS_TURN_PREFIX = 'Resume rejected by --resume-drops-turn:'

const isHumanSourced = (message: UserMessage) =>
  message.origin === undefined || message.origin.kind === 'human'

function isInterruptMarker(message: UserMessage): boolean {
  const content = message.message.content
  const text =
    typeof content === 'string'
      ? content
      : content.length === 1 && content[0]?.type === 'text'
        ? content[0].text
        : undefined
  return text === INTERRUPT_MESSAGE || text === INTERRUPT_MESSAGE_FOR_TOOL_USE
}

function isToolResult(message: UserMessage): boolean {
  const content = message.message.content
  return Array.isArray(content) && content.length > 0 && content.every(block => block.type === 'tool_result')
}

// Entries a truncating resume may drop before the declared prompt: they carry no
// conversation content the caller could have missed.
function isFurniture(message: Message): boolean {
  if (message.type === 'system' || message.type === 'progress') return true
  if (message.type === 'attachment') return message.attachment.type !== 'queued_command'
  if (message.type === 'user') return isHumanSourced(message) && (isInterruptMarker(message) || message.isMeta === true)
  return false
}

function describe(message: Message, index: number): string {
  const kind = message.type === 'attachment' ? ` (${message.attachment.type})` : ''
  return `entry ${index} [type=${message.type}${kind}, uuid=${message.uuid}]`
}

/**
 * Checks that every entry a --resume-session-at truncation discards belongs to the
 * turn whose prompt UUID is `turnId`. Returns the refusal reason, or undefined when
 * the truncation is safe.
 */
export function checkResumeDropsTurn(discarded: Message[], turnId: string): string | undefined {
  if (validateUuid(turnId) === null) return `declared turn id is not a UUID: ${turnId}`
  let start = 0
  while (start < discarded.length && isFurniture(discarded[start]!)) start++
  const prompt = discarded[start]
  if (!prompt) return undefined
  if (prompt.type !== 'user' || prompt.uuid !== turnId)
    return `range does not start with the declared turn prompt; first discarded ${describe(prompt, start)}`
  if (prompt.isMeta || prompt.isCompactSummary || isToolResult(prompt))
    return `declared turn id names a non-prompt user entry; ${describe(prompt, start)}`
  if (!isHumanSourced(prompt)) return `declared turn id names an externally-sourced entry; ${describe(prompt, start)}`

  for (let i = start + 1; i < discarded.length; i++) {
    const entry = discarded[i]!
    switch (entry.type) {
      case 'assistant':
      case 'progress':
      case 'system':
        continue
      case 'attachment':
        if (entry.attachment.type === 'queued_command')
          return `range contains absorbed queued content; ${describe(entry, i)}`
        continue
      case 'user':
        if (entry.isCompactSummary) return `range contains a compaction summary; ${describe(entry, i)}`
        if (!isHumanSourced(entry)) return `range contains an externally-sourced user entry; ${describe(entry, i)}`
        if (isToolResult(entry) || isInterruptMarker(entry) || entry.isMeta) continue
        return `range contains a user entry not attributable to the declared turn; ${describe(entry, i)}`
      default:
        return `range contains an unrecognized entry; ${describe(entry, i)}`
    }
  }
  return undefined
}
