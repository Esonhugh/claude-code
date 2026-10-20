import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Attachment } from '../../utils/attachments.js'
import type { ModSnapshot } from './runtime.js'
import type { ModInput } from './types.js'

const mentionTypes = ['file', 'already_read_file', 'pdf_reference']
const pinned = ['mention', 'agentId'] as const

export type PromptMentionInput = { mention: string; path: string; offset?: number; limit?: number; agentId?: string }

function isCount(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value > 0)
}

export function validatePromptMentionResult(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('prompt.mention must return { type, context? } or { deny }')
  const result = value as ModInput
  if (result.deny !== undefined) {
    if (typeof result.deny !== 'string') throw new TypeError('prompt.mention deny must be a string')
    return
  }
  if (result.type !== null && !mentionTypes.includes(result.type as string))
    throw new TypeError(`prompt.mention type must be ${mentionTypes.join(', ')} or null`)
  if (result.context !== undefined && (!Array.isArray(result.context) || result.context.some(item => typeof item !== 'string' || item === '')))
    throw new TypeError('prompt.mention context must be non-empty strings')
}

/**
 * Raises `prompt.mention` for one `@` path before the engine reads it. `read`
 * is the engine's read (deny rules included); one read per mention.
 */
export async function dispatchModPromptMention(
  snapshot: Pick<ModSnapshot, 'dispatch'>,
  input: PromptMentionInput,
  read: (path: string, offset?: number, limit?: number) => Promise<Attachment | null>,
  signal: AbortSignal,
): Promise<Attachment[]> {
  let first: Promise<Attachment | null> | undefined
  const result = await snapshot.dispatch('prompt.mention', input as ModInput, async rewritten => {
    first ??= read(rewritten.path as string, rewritten.offset as number | undefined, rewritten.limit as number | undefined)
    const attachment = await first
    return { type: attachment && mentionTypes.includes(attachment.type) ? attachment.type : null }
  }, {
    signal,
    restoreInput(value, received) {
      const restored = { ...value }
      for (const key of pinned) if (!Object.hasOwn(restored, key) && Object.hasOwn(received, key)) restored[key] = received[key]
      return restored
    },
    validateInput(value, received) {
      for (const key of pinned)
        if (!isDeepStrictEqual(value[key], received[key])) throw new Error(`prompt.mention cannot rewrite ${key}`)
      if (typeof value.path !== 'string' || !isAbsolute(value.path)) throw new TypeError('prompt.mention path must be absolute')
      if (!isCount(value.offset) || !isCount(value.limit)) throw new TypeError('prompt.mention offset and limit must be positive integers')
    },
    validateResult: validatePromptMentionResult,
  }) as ModInput
  validatePromptMentionResult(result)
  if (typeof result.deny === 'string') return []
  const attachment = first ? await first : null
  const context = (result.context as string[] | undefined) ?? []
  return [
    ...(attachment ? [attachment] : []),
    ...(context.length ? [{
      type: 'hook_additional_context' as const,
      content: context,
      hookName: 'prompt.mention',
      toolUseID: `prompt-mention-${input.mention}`,
      hookEvent: 'UserPromptSubmit' as const,
      modEvent: 'prompt.mention' as const,
    }] : []),
  ]
}
