import { isDeepStrictEqual } from 'node:util'
import { randomUUID, type UUID } from 'node:crypto'
import type { Message } from '../../types/message.js'
import { createSystemMessage, createUserMessage } from '../../utils/messages.js'
import { logForDebugging } from '../../utils/debug.js'
import type { ModSnapshot } from './runtime.js'
import type { ModInput } from './types.js'

export type SessionAppendDoor =
  | 'prompt' | 'command' | 'response' | 'tool-result' | 'tool-message' | 'delivery'
  | 'attachment' | 'hook-context' | 'note' | 'compaction' | 'notice' | 'queue'
export type SessionAppendBlock = { type: string; [key: string]: unknown }
export type SessionAppendMessage = {
  type: 'user' | 'assistant' | 'attachment' | 'system'
  name?: string
  role?: 'user' | 'assistant'
  isMeta?: true
  content: SessionAppendBlock[]
}
export type SessionAppendInput = {
  message: SessionAppendMessage
  door: SessionAppendDoor
  origin: ModInput
  uuid: string
  agentId?: string
}
export type SessionAppendResult = { message: SessionAppendMessage; uuid: string } | { deny: string }

const argumentProblem = 'takes { message: { type: "user" | "system", content } } (content an array of text blocks) and an optional agentId (a string)'
const pinnedKeys = ['door', 'origin', 'uuid', 'agentId'] as const
const pinnedMessageKeys = ['type', 'name', 'role', 'isMeta'] as const

function isRecord(value: unknown): value is ModInput {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function modSessionAppendArgs(value: unknown, plugin?: string): { message: { type: 'user' | 'system'; content: SessionAppendBlock[] }; agentId?: string } {
  const message = isRecord(value) ? value.message : undefined
  const isMessage = isRecord(message) && (message.type === 'user' || message.type === 'system') &&
    Array.isArray(message.content) && message.content.every(isRecord)
  const agentId = isRecord(value) ? value.agentId : undefined
  if (!isMessage || (agentId !== undefined && (typeof agentId !== 'string' || agentId === '')))
    throw Object.assign(new Error(`${plugin ? `${plugin}: ` : ''}$.session.append ${argumentProblem}`), { name: 'HooksError' })
  return {
    message: { type: message.type as 'user' | 'system', content: structuredClone(message.content as SessionAppendBlock[]) },
    ...(agentId === undefined ? {} : { agentId: agentId as string }),
  }
}

/** The row a plugin's own append makes, or why the conversation does not take it. */
export function modSessionAppendNote(args: ReturnType<typeof modSessionAppendArgs>): { message: SessionAppendMessage } | { reason: string } {
  const { message } = args
  const other = message.content.find(block => block.type !== 'text' || typeof block.text !== 'string')
  if (other !== undefined)
    return { reason: `a ${typeof other.type === 'string' ? other.type : 'text'} block the conversation does not take from a plugin (a row a plugin appends carries text blocks)` }
  const content = message.content.map(block => ({ type: 'text', text: block.text as string }))
  if (message.type === 'system')
    return content.length === 1 ? { message: { type: 'system', content } } : { reason: 'a notice that is not one text block' }
  return { message: { type: 'user', role: 'user', isMeta: true, content } }
}

export function restoreSessionAppendInput(value: ModInput, received: ModInput): ModInput {
  const restored = { ...value }
  for (const key of pinnedKeys)
    if (!Object.hasOwn(restored, key) && Object.hasOwn(received, key)) restored[key] = received[key]
  if (isRecord(restored.message) && isRecord(received.message)) {
    const message = { ...restored.message }
    for (const key of pinnedMessageKeys)
      if (!Object.hasOwn(message, key) && Object.hasOwn(received.message, key)) message[key] = received.message[key]
    restored.message = message
  }
  return restored
}

export function validateSessionAppendInput(value: ModInput, received: ModInput): void {
  for (const key of pinnedKeys)
    if (!isDeepStrictEqual(value[key], received[key])) throw new Error(`session.append cannot rewrite ${key}`)
  const message = value.message
  if (!isRecord(message) || !Array.isArray(message.content) || !message.content.every(isRecord))
    throw new TypeError('session.append requires message.content blocks')
  for (const key of pinnedMessageKeys)
    if (!isDeepStrictEqual(message[key], (received.message as ModInput)[key])) throw new Error(`session.append cannot rewrite message.${key}`)
}

export function validateSessionAppendResult(result: unknown): void {
  if (isRecord(result) && typeof result.deny === 'string') return
  if (!isRecord(result) || typeof result.uuid !== 'string' || !isRecord(result.message) || !Array.isArray(result.message.content))
    throw new TypeError('session.append must return { message, uuid } or { deny }')
}

/**
 * Applies a hook's rewrite of a row's blocks. Text blocks and a tool_result's
 * content and is_error are rewritable; every tool_result keeps its tool_use_id,
 * and other blocks may only be kept, dropped or moved. Returns undefined when
 * the rewrite cannot be kept.
 */
export function rewriteSessionAppendContent(original: readonly SessionAppendBlock[], rewritten: readonly SessionAppendBlock[]): SessionAppendBlock[] | undefined {
  const results = original.filter(block => block.type === 'tool_result')
  const rewrittenResults = rewritten.filter(block => block.type === 'tool_result')
  if (rewrittenResults.length !== results.length) return undefined
  let resultIndex = 0
  const content: SessionAppendBlock[] = []
  for (const block of rewritten) {
    if (block.type === 'text') {
      if (typeof block.text !== 'string') return undefined
      content.push({ type: 'text', text: block.text })
    } else if (block.type === 'tool_result') {
      const source = results[resultIndex++]!
      const isError = block.is_error === undefined ? source.is_error : block.is_error
      if (isError !== undefined && typeof isError !== 'boolean') return undefined
      if (typeof block.content !== 'string' && !Array.isArray(block.content)) return undefined
      content.push({ ...source, content: block.content, ...(isError === undefined ? {} : { is_error: isError }) })
    } else if (original.some(kept => isDeepStrictEqual(kept, block))) {
      content.push(block)
    } else return undefined
  }
  return content
}

/** The engine message a host keeps for a plugin's own row. */
export function sessionAppendEngineMessage({ message, uuid }: { message: SessionAppendMessage; uuid: string }): Message {
  const texts = message.content.map(block => block.text as string)
  if (message.type === 'system') return { ...createSystemMessage(texts[0]!, 'info'), uuid: uuid as UUID }
  return createUserMessage({ content: texts.map(text => ({ type: 'text' as const, text })), isMeta: true, uuid })
}

/**
 * Raises `session.append` (door `tool-result`) for one tool result row before
 * the model or the transcript reads it, and keeps a hook's content rewrite.
 */
export async function appendModToolResult<T extends Extract<Message, { type: 'user' }>>(
  snapshot: ModSnapshot,
  row: T,
  toolUses: readonly { id: string; name: string }[],
  context: { agentId?: string; abortController: AbortController },
): Promise<T> {
  const content = row.message.content
  if (!Array.isArray(content)) return row
  const result = content.find(block => block.type === 'tool_result') as { tool_use_id: string } | undefined
  if (!result) return row
  const blocks = content as unknown as SessionAppendBlock[]
  const input: SessionAppendInput = {
    message: { type: 'user', role: 'user', ...(row.isMeta ? { isMeta: true as const } : {}), content: structuredClone(blocks) },
    door: 'tool-result',
    origin: { kind: 'tool', tool: toolUses.find(use => use.id === result.tool_use_id)?.name ?? 'unknown' },
    uuid: row.uuid,
    ...(context.agentId === undefined ? {} : { agentId: context.agentId }),
  }
  let kept: SessionAppendBlock[] = blocks
  try {
    const answer = await snapshot.dispatch('session.append', input as unknown as ModInput, async rewritten => {
      const message = rewritten.message as SessionAppendMessage
      kept = rewriteSessionAppendContent(blocks, message.content) ?? blocks
      if (kept === blocks && !isDeepStrictEqual(message.content, blocks))
        logForDebugging(`session.append: a rewrite of row ${row.uuid} is not kept: what it changed is pinned, rendered per request or carries media`)
      return { message: { ...input.message, content: kept }, uuid: row.uuid }
    }, {
      signal: context.abortController.signal,
      restoreInput: restoreSessionAppendInput,
      validateInput: validateSessionAppendInput,
      validateResult: validateSessionAppendResult,
    })
    validateSessionAppendResult(answer)
  } catch (error) {
    logForDebugging(`session.append tool-result: the dispatch failed, the row is kept as made: ${String(error)}`)
    return row
  }
  return kept === blocks ? row : { ...row, message: { ...row.message, content: kept as unknown as typeof content } }
}

/**
 * Raises `session.append` (door `queue`) for a message queue record's text, a
 * user row the conversation never keeps; the record keeps a hook's text.
 */
export async function appendModQueueRecord(
  snapshot: Pick<ModSnapshot, 'dispatch'>,
  text: string,
  origin: ModInput,
): Promise<string> {
  const input: SessionAppendInput = {
    message: { type: 'user', role: 'user', content: [{ type: 'text', text }] },
    door: 'queue',
    origin,
    uuid: randomUUID(),
  }
  let kept = text
  await snapshot.dispatch('session.append', input as unknown as ModInput, async rewritten => {
    const content = rewriteSessionAppendContent(input.message.content, (rewritten.message as SessionAppendMessage).content)
    if (content) kept = content.map(block => block.text as string).join('')
    return { message: { ...input.message, content: content ?? input.message.content }, uuid: input.uuid }
  }, {
    restoreInput: restoreSessionAppendInput,
    validateInput: validateSessionAppendInput,
    validateResult: validateSessionAppendResult,
  })
  return kept
}
