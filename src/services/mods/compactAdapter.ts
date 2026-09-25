import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { createToolCatalogForContext } from './toolCatalog.js'
import { createModToolHost } from './toolHost.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import {
  createAssistantMessage,
  createCompactBoundaryMessage,
  createUserMessage,
} from '../../utils/messages.js'
import {
  annotateBoundaryWithPreservedSegment,
  buildPostCompactMessages,
  type CompactionResult,
} from '../compact/compact.js'
import {
  projectModSessionMessages,
  type ModSessionMessage,
} from './sessionMessages.js'
import { captureModSessionUsage } from './sessionUsage.js'
import type { ModInput } from './types.js'

type CompactMessage = ModSessionMessage & { handle?: string }
type CompactResult = { messages: CompactMessage[]; tokensBefore?: number; tokensAfter?: number; skip?: undefined } | { skip: string; messages?: undefined; tokensBefore?: undefined; tokensAfter?: undefined }

function validateMessages(value: unknown): asserts value is CompactMessage[] {
  if (!Array.isArray(value)) throw new TypeError('session.compact messages must be an array')
  for (const message of value) {
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.text !== 'string' || !Array.isArray(message.toolUses) ||
      (message.handle !== undefined && typeof message.handle !== 'string') ||
      (message.toolResults !== undefined && !Array.isArray(message.toolResults)))
      throw new TypeError('session.compact requires SessionMessage values')
    for (const tool of message.toolUses) {
      if (!tool || typeof tool.tool_use_id !== 'string' || typeof tool.tool !== 'string' || !tool.input || typeof tool.input !== 'object' || Array.isArray(tool.input))
        throw new TypeError('session.compact invalid tool use')
    }
    for (const result of message.toolResults ?? []) {
      if (!result || typeof result.tool_use_id !== 'string' || typeof result.text !== 'string' || typeof result.isError !== 'boolean')
        throw new TypeError('session.compact invalid tool result')
    }
  }
}

export function validateModCompactInput(input: ModInput): void {
  if (!['manual', 'auto', 'plugin', 'precompute'].includes(input.trigger as string) ||
    (input.agentId !== undefined && typeof input.agentId !== 'string') ||
    (input.instructions !== undefined && typeof input.instructions !== 'string'))
    throw new TypeError('session.compact invalid trigger, agentId or instructions')
  validateMessages(input.messages)
}

export function validateModCompactResult(value: unknown): asserts value is CompactResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('session.compact must return messages or skip')
  const result = value as CompactResult
  if (result.skip !== undefined) {
    if (typeof result.skip !== 'string' || !result.skip.trim() || result.messages !== undefined) throw new TypeError('session.compact must return messages or skip')
    return
  }
  validateMessages(result.messages)
  if (!result.messages.length) throw new TypeError('session.compact must return nonempty messages')
  for (const count of [result.tokensBefore, result.tokensAfter]) {
    if (count !== undefined && (typeof count !== 'number' || !Number.isFinite(count) || count < 0))
      throw new TypeError('session.compact token counts must be nonnegative finite numbers')
  }
}

/** Keeps transcript handles scoped to this compaction, never to the plugin realm. */
export async function runModSessionCompact(
  context: ToolUseContext,
  trigger: 'manual' | 'auto',
  messages: Message[],
  instructions: string | undefined,
  core: (messages: Message[], instructions: string | undefined, context: ToolUseContext) => Promise<CompactionResult>,
  canUseTool: CanUseToolFn,
): Promise<{ compactionResult: CompactionResult; skip?: undefined } | { skip: string; compactionResult?: undefined }> {
  const signal = context.abortController.signal
  signal.throwIfAborted()
  const host = context.modsSnapshot ?? context.mods
  if (!host?.hasHooks('session.compact')) {
    return { compactionResult: await core(messages, instructions, context) }
  }
  const borrowedSnapshot = context.modsSnapshot
  const snapshot =
    borrowedSnapshot ??
    context.mods!.capture({
      toolCatalog: () => createToolCatalogForContext(context),
      toolHost: () => createModToolHost(context, canUseTool),
      captureUsage: () => captureModSessionUsage({ ...context, messages }),
    })
  const handles = new Map<string, Message>()
  const ids = new Map<Message, string>()
  const results: { value: CompactResult; result: CompactionResult }[] = []
  function project(list: Message[]): CompactMessage[] {
    const visible = list.filter(
      (
        message,
      ): message is Extract<Message, { type: 'user' | 'assistant' }> =>
        message.type === 'user' || message.type === 'assistant',
    )
    // Compaction includes summary/meta rows, unlike session.messages(). Clear
    // those flags on this exact source list before projecting so index mapping
    // cannot drift while tool uses still retain following result summaries.
    const projected = projectModSessionMessages(
      visible.map(message =>
        message.type === 'user'
          ? { ...message, isMeta: undefined, isVirtual: undefined }
          : message,
      ),
      Infinity,
    )
    return projected.map((message, index) => {
      const original = visible[index]!
      let handle = ids.get(original)
      if (!handle) {
        handle = randomUUID()
        ids.set(original, handle)
        handles.set(handle, original)
      }
      return { ...message, handle }
    })
  }
  function restore(list: CompactMessage[]): Message[] {
    return list.map(message => {
      if (message.handle !== undefined) {
        const original = handles.get(message.handle)
        if (!original) throw new TypeError('session.compact unknown message handle')
        return original
      }
      const text = message.text ? [{ type: 'text' as const, text: message.text }] : []
      return message.role === 'assistant'
        ? createAssistantMessage({ content: [...text, ...message.toolUses.map(tool => ({ type: 'tool_use' as const, id: tool.tool_use_id, name: tool.tool, input: tool.input }))] as any })
        : createUserMessage({ content: [...text, ...(message.toolResults ?? []).map(result => ({ type: 'tool_result' as const, tool_use_id: result.tool_use_id, content: result.text, is_error: result.isError }))] })
    })
  }
  try {
    const input = { trigger, ...(context.agentId === undefined ? {} : { agentId: context.agentId }), ...(instructions === undefined ? {} : { instructions }), messages: project(messages) }
    const result = await snapshot.dispatch('session.compact', input, async (rewritten, coreSignal) => {
      const compactMessages = isDeepStrictEqual(rewritten.messages, input.messages) ? messages : restore(rewritten.messages as CompactMessage[])
      const controller = new AbortController()
      const abort = () => controller.abort(coreSignal?.reason)
      coreSignal?.addEventListener('abort', abort, { once: true })
      if (coreSignal?.aborted) abort()
      try {
        controller.signal.throwIfAborted()
        const compacted = await core(
          compactMessages,
          rewritten.instructions as string | undefined,
          { ...context, messages: compactMessages, abortController: controller },
        )
        controller.signal.throwIfAborted()
        const value = { messages: project(buildPostCompactMessages(compacted)), ...(compacted.preCompactTokenCount === undefined ? {} : { tokensBefore: compacted.preCompactTokenCount }), ...(compacted.postCompactTokenCount === undefined ? {} : { tokensAfter: compacted.postCompactTokenCount }) }
        results.push({ value: structuredClone(value), result: compacted })
        return value
      } finally { coreSignal?.removeEventListener('abort', abort) }
    }, {
      signal,
      validateInput: value => { restore(value.messages as CompactMessage[]) },
      validateResult: value => {
        validateModCompactResult(value)
        if (value.skip === undefined) restore(value.messages)
      },
    })
    signal.throwIfAborted()
    validateModCompactResult(result)
    if (result.skip !== undefined) return { skip: result.skip }
    const original = results.findLast(item => isDeepStrictEqual(item.value, result))
    if (original) return { compactionResult: original.result }
    const messagesToKeep = restore(result.messages)
    const boundary = createCompactBoundaryMessage(trigger, result.tokensBefore ?? 0, messages.at(-1)?.uuid)
    return { compactionResult: {
      boundaryMarker: annotateBoundaryWithPreservedSegment(boundary, boundary.uuid, messagesToKeep),
      summaryMessages: [], messagesToKeep, attachments: [], hookResults: [],
      ...(result.tokensBefore === undefined ? {} : { preCompactTokenCount: result.tokensBefore }),
      ...(result.tokensAfter === undefined ? {} : { postCompactTokenCount: result.tokensAfter }),
    } }
  } finally { if (!borrowedSnapshot) snapshot.release() }
}
