import { isEqual } from 'lodash-es'
import { createHash } from 'node:crypto'
import type {
  ContentBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type { Tool, ToolUseContext } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import { createUserMessage } from '../../utils/messages.js'
import {
  buildLargeToolResultMessage,
  generatePreview,
  persistToolResult,
  PREVIEW_SIZE_BYTES,
  processPreMappedToolResultBlock,
  processToolResultBlock,
} from '../../utils/toolResultStorage.js'
import type { MessageUpdateLazy } from '../tools/toolExecution.js'
import type { ModSnapshot } from './runtime.js'
import type { ModInput } from './types.js'

/** Filled by the existing tool pipeline after classic output rewriting. */
export type ModToolExecutionRecord = {
  input: ModInput
  hasResult: boolean
  result?: unknown
  error?: unknown
  messages: MessageUpdateLazy[]
}

export type ToolCallResult = {
  result?: unknown
  deny?: string
  ref?: number
  text?: string
  isError?: true
  context?: readonly string[]
}

export async function runModToolCall({
  snapshot,
  tool,
  toolUseID,
  input,
  toolUseContext,
  assistantMessage,
  core,
  review,
}: {
  snapshot: ModSnapshot
  tool: Tool
  toolUseID: string
  input: ModInput
  toolUseContext: ToolUseContext
  assistantMessage: AssistantMessage
  core: (
    input: ModInput,
    record: ModToolExecutionRecord,
    signal?: AbortSignal,
  ) => Promise<MessageUpdateLazy[]>
  /** Host review after user dispatch, before mapping/persistence; never replays core. */
  review?: (
    input: ModInput,
    output: unknown,
    context: readonly string[],
  ) => Promise<{
    output: unknown
    messages: MessageUpdateLazy[]
    context: readonly string[]
  }>
}): Promise<MessageUpdateLazy[]> {
  const runs: ModToolExecutionRecord[] = []
  const referencedRuns: ModToolExecutionRecord[] = []
  const pending: Promise<unknown>[] = []
  const event = {
    ...input,
    tool: tool.name,
    tool_use_id: toolUseID,
    agentId: toolUseContext.agentId,
  }
  const toolResult = (update: MessageUpdateLazy) => {
    const message = update.message
    return message.type === 'user' && Array.isArray(message.message.content)
      ? (message.message.content.find(
          block =>
            block.type === 'tool_result' && block.tool_use_id === toolUseID,
        ) as ToolResultBlockParam | undefined)
      : undefined
  }
  const failed = (run: ModToolExecutionRecord) =>
    run.error !== undefined ||
    run.messages.some(update => {
      const block = toolResult(update)
      return block?.is_error === true
    })
  function valueOf(run: ModToolExecutionRecord) {
    if (run.hasResult) return run.result
    const message = run.messages.find(update => toolResult(update))?.message
    return message?.type === 'user' ? message.toolUseResult : undefined
  }
  function matchingRun(value: ToolCallResult) {
    if (value.deny !== undefined) return undefined
    const referenced =
      value.ref !== undefined ? referencedRuns[value.ref - 1] : undefined
    if (
      referenced?.messages.length &&
      (value.result === undefined || isEqual(value.result, valueOf(referenced)))
    )
      return referenced
    return runs.findLast(
      run => run.messages.length && isEqual(value.result, valueOf(run)),
    )
  }
  function validateResult(
    value: unknown,
    nextResults: readonly unknown[] = [],
  ): asserts value is ToolCallResult {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new Error('tool.call must return an object')
    const result = value as ToolCallResult
    if (result.deny !== undefined) {
      if (typeof result.deny !== 'string')
        throw new Error('tool.call deny must be a string')
      return
    }
    if (!('result' in result))
      throw new Error('tool.call must return result or deny')
    if (
      result.ref !== undefined &&
      (!Number.isSafeInteger(result.ref) ||
        result.ref < 1 ||
        !referencedRuns[result.ref - 1])
    )
      throw new Error('tool.call ref must identify an execution of this call')
    if (result.context !== undefined) {
      if (!Array.isArray(result.context))
        throw new Error('tool.call context must be a list of texts')
      for (let index = 0; index < result.context.length; index++) {
        const item = result.context[index]
        if (
          !Object.hasOwn(result.context, index) ||
          typeof item !== 'string' ||
          item === ''
        )
          throw new Error('tool.call context must contain non-empty texts')
      }
    }
    const downstream = (nextResults as readonly ToolCallResult[]).filter(
      item => item.deny === undefined,
    )
    const matching = downstream.filter(item =>
      isEqual(item.result, result.result),
    )
    for (const below of matching.length ? matching : downstream) {
      const remaining = new Map<string, number>()
      for (const item of result.context ?? [])
        remaining.set(item, (remaining.get(item) ?? 0) + 1)
      for (const item of below.context ?? []) {
        const count = remaining.get(item) ?? 0
        if (count === 0)
          throw new Error(
            'tool.call cannot remove context attached by a downstream hook',
          )
        remaining.set(item, count - 1)
      }
    }
    if (matchingRun(result)) return
    if (runs.at(-1) && failed(runs.at(-1)!))
      throw new Error(
        'tool.call cannot replace a failed or denied execution with a successful result',
      )
    if (
      tool.outputSchema &&
      !tool.outputSchema.safeParse(result.result).success
    )
      throw new Error(
        `tool.call result does not match ${tool.name} output schema`,
      )
  }

  let result: unknown
  try {
    result = await snapshot.dispatch(
      'tool.call',
      event,
      (rewritten, signal) => {
        const { tool: name, tool_use_id: id, agentId, ...args } = rewritten
        if (
          name !== event.tool ||
          id !== event.tool_use_id ||
          agentId !== toolUseContext.agentId
        )
          throw new Error(
            'tool.call cannot rewrite tool, tool_use_id or agentId',
          )
        const record: ModToolExecutionRecord = {
          input: args,
          hasResult: false,
          messages: [],
        }
        runs.push(record)
        const execution = (async () => {
          try {
            record.messages = await core(args, record, signal)
          } catch (error) {
            record.error = error
            throw error
          }
          const block = record.messages.map(toolResult).find(Boolean)
          const text =
            block?.type === 'tool_result'
              ? typeof block.content === 'string'
                ? block.content
                : (block.content
                    ?.filter(item => item.type === 'text')
                    .map(item => item.text)
                    .join('\n') ?? '')
              : ''
          return {
            ref: referencedRuns.push(record),
            result: valueOf(record),
            text,
            ...(failed(record) ? { isError: true } : {}),
          }
        })()
        pending.push(execution)
        return execution
      },
      { signal: toolUseContext.abortController.signal, validateResult },
    )
  } finally {
    // A Mod can return without awaiting next. Cancellation also ends dispatch
    // before a non-cancellable tool finishes; neither releases its admission.
    await Promise.allSettled(pending)
  }
  toolUseContext.abortController.signal.throwIfAborted()
  validateResult(result)
  const finalResult = result as ToolCallResult
  let unchanged = matchingRun(finalResult)
  const last = runs.at(-1)
  const source = unchanged ?? last
  let context = finalResult.deny === undefined ? (finalResult.context ?? []) : []
  let reviewedMessages: MessageUpdateLazy[] = []
  // Real failures were reviewed in the existing catch path. No-next deny is
  // not an execution; deny after execution still reviews the last real output.
  if (
    review &&
    (finalResult.deny === undefined || last?.hasResult) &&
    !(source && failed(source))
  ) {
    const output =
      finalResult.deny !== undefined
        ? last
          ? valueOf(last)
          : undefined
        : unchanged
          ? valueOf(unchanged)
          : finalResult.result
    const reviewed = await review(source?.input ?? input, output, context)
    toolUseContext.abortController.signal.throwIfAborted()
    reviewedMessages = reviewed.messages
    context = reviewed.context
    if (
      finalResult.deny === undefined &&
      !isEqual(output, reviewed.output)
    ) {
      finalResult.result = reviewed.output
      unchanged = undefined
    }
  }
  toolUseContext.modToolCallResult?.(
    finalResult.deny === undefined && (finalResult.context !== undefined || context.length)
      ? { ...finalResult, context }
      : finalResult,
  )
  async function additionalContext(): Promise<MessageUpdateLazy[]> {
    if (toolUseContext.modToolCallResult || finalResult.deny !== undefined || !context.length) return []
    const signal = toolUseContext.abortController.signal
    async function persist(content: string): Promise<string> {
      signal.throwIfAborted()
      // A review can change the content of the same call. Content-address the
      // reviewed bytes separately from the call ID so wx never reuses stale data.
      const callHash = createHash('sha256').update(toolUseID).digest('hex')
      const contentHash = createHash('sha256').update(content).digest('hex')
      const saved = await persistToolResult(
        content,
        `mods-context-${callHash}-${contentHash}`,
      )
      signal.throwIfAborted()
      return 'error' in saved
        ? `[tool.call context persistence failed: ${saved.error}. Full context was not saved; showing only the head.]\n${generatePreview(content, PREVIEW_SIZE_BYTES).preview}`
        : buildLargeToolResultMessage(saved)
    }
    const content: string[] = []
    if (context.reduce((total, item) => total + item.length, 0) > 200_000)
      content.push(await persist(JSON.stringify(context)))
    else
      for (const item of context)
        content.push(item.length > 100_000 ? await persist(item) : item)
    signal.throwIfAborted()
    return [
      {
        message: createAttachmentMessage({
          type: 'hook_additional_context',
          content,
          hookName: 'tool.call',
          toolUseID: `${toolUseID}-context`,
          hookEvent: 'PostToolUse',
          modEvent: 'tool.call',
        }),
      },
    ]
  }
  if (unchanged) {
    if (unchanged.hasResult && !failed(unchanged)) {
      for (const update of unchanged.messages) {
        const block = toolResult(update)
        if (
          !block ||
          update.message.type !== 'user' ||
          !Array.isArray(update.message.message.content)
        )
          continue
        const processed = await processPreMappedToolResultBlock(
          block,
          tool.name,
          tool.maxResultSizeChars,
        )
        if (processed !== block) Object.assign(block, processed)
      }
    }
    const attachments = await additionalContext()
    return attachments.length || reviewedMessages.length
      ? [...unchanged.messages, ...reviewedMessages, ...attachments]
      : unchanged.messages
  }

  const output =
    finalResult.deny === undefined && tool.outputSchema
      ? tool.outputSchema.parse(finalResult.result)
      : finalResult.result
  const mapped =
    finalResult.deny !== undefined
      ? {
          type: 'tool_result' as const,
          tool_use_id: toolUseID,
          content: `<tool_use_error>${finalResult.deny}</tool_use_error>`,
          is_error: true,
        }
      : await processToolResultBlock(tool, output, toolUseID)
  const original = source?.messages.find(update => toolResult(update))
  const oldMessage =
    original?.message.type === 'user' ? original.message : undefined
  const message = createUserMessage({
    content:
      oldMessage && Array.isArray(oldMessage.message.content)
        ? (oldMessage.message.content as ContentBlockParam[]).map(block =>
            block.type === 'tool_result' && block.tool_use_id === toolUseID
              ? mapped
              : block,
          )
        : [mapped],
    imagePasteIds: oldMessage?.imagePasteIds,
    mcpMeta: oldMessage?.mcpMeta,
    toolUseResult:
      toolUseContext.agentId && !toolUseContext.preserveToolUseResults
        ? undefined
        : finalResult.deny !== undefined
          ? `Error: ${finalResult.deny}`
          : output,
    sourceToolAssistantUUID: assistantMessage.uuid,
  })
  // Preserve context changes even when the Mod hides the output: deny cannot
  // undo execution, and dropping a task/Agent context modifier loses ownership.
  const replacement: MessageUpdateLazy = {
    message,
    contextModifier: original?.contextModifier,
  }
  return [
    ...(source && original
      ? source.messages.map(update =>
          update === original ? replacement : update,
        )
      : [...(source?.messages ?? []), replacement]),
    ...reviewedMessages,
    ...(await additionalContext()),
  ]
}
