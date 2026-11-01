import { randomUUID, type UUID } from 'crypto'
import { getPromptId } from '../../bootstrap/state.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { deriveUUID } from '../messages.js'

// Display-only replacements keyed by the (normalized) message uuid the
// transcript renders with. The stored message is never changed.
const displayOverrides = new Map<string, string>()

export function getMessageDisplayOverride(
  messageId: string,
): string | undefined {
  return displayOverrides.get(messageId)
}

/**
 * Run MessageDisplay hooks on each text block of a finished assistant message
 * before it is displayed. Each block is one final flush (index 0, final true).
 */
export async function applyMessageDisplayHooks(
  message: Message,
  toolUseContext?: ToolUseContext,
): Promise<void> {
  if (message.type !== 'assistant') return
  const content = message.message.content
  if (!Array.isArray(content)) return
  // Loaded lazily: the transcript renderer imports this module for the
  // overrides and should not pull in the hook executor.
  const { executeMessageDisplayHooks } = await import('../hooks.js')
  for (const [index, block] of content.entries()) {
    if (block.type !== 'text' || !block.text) continue
    let displayContent: string | undefined
    for await (const result of executeMessageDisplayHooks(
      {
        turnId: getPromptId() ?? message.uuid,
        messageId: message.uuid,
        index: 0,
        final: true,
        delta: block.text,
      },
      toolUseContext,
      toolUseContext?.abortController.signal,
    )) {
      if (result.displayContent !== undefined) {
        displayContent = result.displayContent
      }
    }
    if (displayContent === undefined) continue
    // normalizeMessages keeps the uuid for single-block messages and derives
    // one per block otherwise, so record both.
    if (content.length === 1) displayOverrides.set(message.uuid, displayContent)
    displayOverrides.set(deriveUUID(message.uuid as UUID, index), displayContent)
  }
}

/**
 * Headless/SDK path: run MessageDisplay once on a completed assistant message
 * (texts joined, index 0, final) and return the copy to emit. The first text
 * block carries the display text; later text blocks are emptied.
 */
export async function applyCompletedMessageDisplayHooks<T extends Message>(
  message: T,
  turnId: string,
  signal?: AbortSignal,
): Promise<T> {
  if (message.type !== 'assistant' || !Array.isArray(message.message.content)) return message
  const content = message.message.content
  const text = content.map(block => (block.type === 'text' ? block.text : '')).join('')
  if (text === '') return message
  const { executeMessageDisplayHooks } = await import('../hooks.js')
  let displayContent: string | undefined
  for await (const result of executeMessageDisplayHooks(
    { turnId, messageId: randomUUID(), index: 0, final: true, delta: text },
    undefined,
    signal,
  )) {
    if (result.displayContent !== undefined) displayContent = result.displayContent
  }
  if (displayContent === undefined) return message
  let first = true
  return {
    ...message,
    message: {
      ...message.message,
      content: content.map(block => {
        if (block.type !== 'text') return block
        const replaced = { ...block, text: first ? displayContent : '' }
        first = false
        return replaced
      }),
    },
  }
}
