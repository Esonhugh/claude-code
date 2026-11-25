import type {
  BetaContentBlockParam,
  BetaMessageParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import {
  type AdvisorToolAttachment,
  getAdvisorAnnouncementText,
} from './advisor.js'

/**
 * Placeholder block normalizeMessagesForAPI leaves where an advisor_tool
 * attachment with a toolChange sat, so message merging keeps its position.
 * splitAdvisorToolChanges turns it into the role:"system" turn the
 * mid-conversation tool-change beta reads. Never sent as is.
 */
export type AdvisorToolChangeMarker = {
  type: 'advisor_tool_change'
  op: 'add' | 'remove'
  text: string
  cache_control?: unknown
}

export function createAdvisorToolChangeMarker(
  attachment: AdvisorToolAttachment & { toolChange: 'add' | 'remove' },
): AdvisorToolChangeMarker {
  return {
    type: 'advisor_tool_change',
    op: attachment.toolChange,
    text: getAdvisorAnnouncementText(attachment),
  }
}

export function isAdvisorToolChangeMarker(
  block: unknown,
): block is AdvisorToolChangeMarker {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: unknown }).type === 'advisor_tool_change'
  )
}

/**
 * Placeholder normalizeMessagesForAPI leaves for a notice official 2.1.329
 * sends as its own role:"system" turn after the user turn (a stop notice).
 * splitSystemTurns turns it into that turn. Never sent as is.
 */
export type SystemNoticeMarker = {
  type: 'system_notice'
  text: string
  cache_control?: unknown
}

export function createSystemNoticeMarker(text: string): SystemNoticeMarker {
  return { type: 'system_notice', text }
}

/** Either placeholder that becomes a role:"system" turn. */
export function isSystemTurnMarker(
  block: unknown,
): block is AdvisorToolChangeMarker | SystemNoticeMarker {
  if (typeof block !== 'object' || block === null) return false
  const type = (block as { type?: unknown }).type
  return type === 'advisor_tool_change' || type === 'system_notice'
}

/** A role:"system" turn (beta `mid-conversation-system-2026-04-07`). */
export type SystemTurnParam = {
  role: 'system'
  content: Record<string, unknown>[]
}

function toSystemTurn(
  marker: AdvisorToolChangeMarker | SystemNoticeMarker,
): SystemTurnParam {
  if (marker.type === 'system_notice') {
    const text: Record<string, unknown> = { type: 'text', text: marker.text }
    if (marker.cache_control !== undefined) {
      text.cache_control = marker.cache_control
    }
    return { role: 'system', content: [text] }
  }
  const block: Record<string, unknown> = {
    type: marker.op === 'add' ? 'tool_addition' : 'tool_removal',
    tool: { type: 'tool_reference', name: 'advisor' },
  }
  if (marker.cache_control !== undefined) {
    block.cache_control = marker.cache_control
  }
  return { role: 'system', content: [{ type: 'text', text: marker.text }, block] }
}

/**
 * Turns each marker into a system turn at its place: the user message is cut
 * there, so the turns keep their order and an earlier request's messages stay
 * a prefix of the next one's. A marker with nothing before it in its message
 * goes after that message's content instead, so a system turn always follows
 * a user turn. A message holding only markers becomes its system turns.
 */
export function splitSystemTurns(
  messages: BetaMessageParam[],
): (BetaMessageParam | SystemTurnParam)[] {
  if (!messages.some(hasMarker)) return messages
  const out: (BetaMessageParam | SystemTurnParam)[] = []
  for (const message of messages) {
    if (!hasMarker(message)) {
      out.push(message)
      continue
    }
    let blocks: unknown[] = []
    let pending: SystemTurnParam[] = []
    const flush = () => {
      if (blocks.length === 0) return
      out.push({ ...message, content: blocks as BetaContentBlockParam[] })
      blocks = []
      out.push(...pending)
      pending = []
    }
    for (const block of message.content as unknown[]) {
      if (!isSystemTurnMarker(block)) {
        blocks.push(block)
        continue
      }
      pending.push(toSystemTurn(block))
      flush()
    }
    flush()
    if (pending.length > 0 && out.length === 0) {
      // Never open the conversation with a system turn.
      const first = pending[0]!
      out.push({ ...message, content: [first.content.shift() as unknown as BetaContentBlockParam] })
      if (first.content.length === 0) pending.shift()
    }
    out.push(...pending)
  }
  return out
}

function hasMarker(message: BetaMessageParam): boolean {
  return (
    message.role === 'user' &&
    Array.isArray(message.content) &&
    message.content.some(isSystemTurnMarker)
  )
}

