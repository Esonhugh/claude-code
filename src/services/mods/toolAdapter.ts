import { isEqual } from 'lodash-es'
import type {
  ContentBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type { Tool, ToolUseContext } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import { createUserMessage } from '../../utils/messages.js'
import {
  processPreMappedToolResultBlock,
  processToolResultBlock,
} from '../../utils/toolResultStorage.js'
import type { MessageUpdateLazy } from '../tools/toolExecution.js'
import type { ModSnapshot } from './runtime.js'
import type { ModInput } from './types.js'

/** Filled by the existing tool pipeline, before mapping or classic output hooks. */
export type ModToolExecutionRecord = {
  input: ModInput
  hasResult: boolean
  result?: unknown
  error?: unknown
  messages: MessageUpdateLazy[]
}

type ToolCallResult = {
  result?: unknown
  deny?: string
  ref?: string
  context?: string | string[]
}

export async function runModToolCall({
  snapshot,
  tool,
  toolUseID,
  input,
  toolUseContext,
  assistantMessage,
  core,
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
  ) => Promise<MessageUpdateLazy[]>
}): Promise<MessageUpdateLazy[]> {
  const runs: ModToolExecutionRecord[] = []
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
      value.ref !== undefined ? runs[Number(value.ref)] : undefined
    if (
      referenced?.messages.length &&
      isEqual(value.result, valueOf(referenced))
    )
      return referenced
    return runs.findLast(
      run => run.messages.length && isEqual(value.result, valueOf(run)),
    )
  }
  function validateResult(value: unknown): asserts value is ToolCallResult {
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
      result.context !== undefined &&
      typeof result.context !== 'string' &&
      !(
        Array.isArray(result.context) &&
        result.context.every(item => typeof item === 'string')
      )
    )
      throw new Error('tool.call context must be text or a list of texts')
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
      rewritten => {
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
        const ref = String(runs.push(record) - 1)
        const execution = (async () => {
          try {
            record.messages = await core(args, record)
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
            ref,
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
  const unchanged = matchingRun(result)
  const last = runs.at(-1)
  const source = unchanged ?? last
  const context =
    result.deny === undefined
      ? (typeof result.context === 'string'
          ? [result.context]
          : (result.context ?? [])
        ).filter(Boolean)
      : []
  const additionalContext: MessageUpdateLazy[] = context.length
    ? [
        {
          message: createAttachmentMessage({
            type: 'hook_additional_context',
            content: context,
            hookName: 'tool.call',
            toolUseID: `${toolUseID}-context`,
            hookEvent: 'PostToolUse',
          }),
        },
      ]
    : []
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
    return additionalContext.length
      ? [...unchanged.messages, ...additionalContext]
      : unchanged.messages
  }

  const output =
    result.deny === undefined && tool.outputSchema
      ? tool.outputSchema.parse(result.result)
      : result.result
  const mapped =
    result.deny !== undefined
      ? {
          type: 'tool_result' as const,
          tool_use_id: toolUseID,
          content: `<tool_use_error>${result.deny}</tool_use_error>`,
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
        : result.deny !== undefined
          ? `Error: ${result.deny}`
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
    ...additionalContext,
  ]
}
