import type {
  AttachmentMessage,
  HookResultMessage,
  Message,
  SystemMessage,
  UserMessage,
} from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { createCompactBoundaryMessage } from '../../utils/messages.js'
import type { CompactionResult } from './compact.js'
import { compactConversation } from './compact.js'
import type { CodexCompactOptions } from './compactMode.js'

export const CODEX_COMPACT_TOOL_RESULT_TRUNCATION_THRESHOLD_CHARS = 32_000
export const CODEX_COMPACT_TRUNCATED_TOOL_OUTPUT =
  '[tool output truncated during codex-style compaction]'

export type CodexCompactMetadata = {
  mode: 'codex'
  retainedMessageCount: number
  retainedApproxTokens: number
  truncatedToolResultCount: number
  droppedAttachmentCount: number
  retainedUserMessageTokens: number
}

export function buildCodexCompactMetadata(input: {
  retainedMessageCount: number
  retainedApproxTokens: number
  truncatedToolResultCount: number
  droppedAttachmentCount: number
  retainedUserMessageTokens: number
}): CodexCompactMetadata {
  return {
    mode: 'codex',
    retainedMessageCount: input.retainedMessageCount,
    retainedApproxTokens: input.retainedApproxTokens,
    truncatedToolResultCount: input.truncatedToolResultCount,
    droppedAttachmentCount: input.droppedAttachmentCount,
    retainedUserMessageTokens: input.retainedUserMessageTokens,
  }
}

export function truncateLargeToolResultsForCodexCompact(
  messages: Message[],
): Message[] {
  return messages.map(message => {
    if (message.type !== 'user') return message
    if (!Array.isArray(message.message.content)) return message

    let changed = false
    const content = message.message.content.map(block => {
      if (block.type !== 'tool_result') return block
      if (typeof block.content !== 'string') return block
      if (
        block.content.length <= CODEX_COMPACT_TOOL_RESULT_TRUNCATION_THRESHOLD_CHARS
      ) {
        return block
      }
      changed = true
      return {
        ...block,
        content: CODEX_COMPACT_TRUNCATED_TOOL_OUTPUT,
      }
    })

    if (!changed) return message

    return {
      ...message,
      message: {
        ...message.message,
        content,
      },
      toolUseResult:
        typeof message.toolUseResult === 'string' &&
        message.toolUseResult.length >
          CODEX_COMPACT_TOOL_RESULT_TRUNCATION_THRESHOLD_CHARS
          ? CODEX_COMPACT_TRUNCATED_TOOL_OUTPUT
          : message.toolUseResult,
    } as Message
  })
}

export function countTruncatedToolResults(
  before: Message[],
  after: Message[],
): number {
  let count = 0
  for (let i = 0; i < before.length; i++) {
    const oldMessage = before[i]
    const newMessage = after[i]
    if (oldMessage?.type !== 'user' || newMessage?.type !== 'user') continue
    if (
      !Array.isArray(oldMessage.message.content) ||
      !Array.isArray(newMessage.message.content)
    ) {
      continue
    }
    for (let j = 0; j < oldMessage.message.content.length; j++) {
      const oldBlock = oldMessage.message.content[j]
      const newBlock = newMessage.message.content[j]
      if (
        oldBlock?.type === 'tool_result' &&
        newBlock?.type === 'tool_result' &&
        typeof oldBlock.content === 'string' &&
        oldBlock.content !== newBlock.content &&
        newBlock.content === CODEX_COMPACT_TRUNCATED_TOOL_OUTPUT
      ) {
        count++
      }
    }
  }
  return count
}

function approximateTextTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function approximateMessageTokens(message: Message): number {
  if (message.type === 'user') {
    const content = message.message.content
    if (typeof content === 'string') return approximateTextTokens(content)
    if (Array.isArray(content)) {
      return content.reduce((sum, block) => {
        if ('text' in block && typeof block.text === 'string') {
          return sum + approximateTextTokens(block.text)
        }
        if ('content' in block && typeof block.content === 'string') {
          return sum + approximateTextTokens(block.content)
        }
        return sum + 10
      }, 0)
    }
  }
  if (message.type === 'assistant' && Array.isArray(message.message.content)) {
    return message.message.content.reduce((sum, block) => {
      if (block.type === 'text') return sum + approximateTextTokens(block.text ?? '')
      return sum + 10
    }, 0)
  }
  return 10
}

function toolUseIdsInMessage(message: Message): string[] {
  if (message.type !== 'assistant') return []
  if (!Array.isArray(message.message.content)) return []
  return message.message.content.flatMap(block =>
    block.type === 'tool_use' && typeof block.id === 'string' ? [block.id] : [],
  )
}

function toolResultIdsInMessage(message: Message): string[] {
  if (message.type !== 'user') return []
  if (!Array.isArray(message.message.content)) return []
  return message.message.content.flatMap(block =>
    block.type === 'tool_result' && typeof block.tool_use_id === 'string'
      ? [block.tool_use_id]
      : [],
  )
}

export function selectRetainedMessagesForCodexCompact(
  messages: Message[],
  retainedUserMessageTokens: number,
): { messages: Message[]; approxTokens: number } {
  const selected = new Set<number>()
  let tokens = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message) continue
    const messageTokens = approximateMessageTokens(message)
    if (tokens > 0 && tokens + messageTokens > retainedUserMessageTokens) {
      break
    }
    selected.add(i)
    tokens += messageTokens

    for (const toolResultId of toolResultIdsInMessage(message)) {
      for (let j = i - 1; j >= 0; j--) {
        const candidate = messages[j]
        if (!candidate) continue
        if (toolUseIdsInMessage(candidate).includes(toolResultId)) {
          if (!selected.has(j)) {
            selected.add(j)
            tokens += approximateMessageTokens(candidate)
          }
          break
        }
      }
    }
  }

  const retained = [...selected]
    .sort((a, b) => a - b)
    .map(index => messages[index]!)

  return { messages: retained, approxTokens: tokens }
}

export function buildCodexStyleCompactionResult(input: {
  boundaryMarker: SystemMessage
  summaryMessages: UserMessage[]
  retainedMessages: Message[]
  minimalAttachments: AttachmentMessage[]
  hookResults: HookResultMessage[]
  preCompactTokenCount?: number
  postCompactTokenCount?: number
  truePostCompactTokenCount?: number
  metadata: CodexCompactMetadata
}): CompactionResult {
  return {
    boundaryMarker: {
      ...input.boundaryMarker,
      compactMetadata: {
        ...((input.boundaryMarker as { compactMetadata?: Record<string, unknown> })
          .compactMetadata ?? {}),
        ...input.metadata,
      },
    } as SystemMessage,
    summaryMessages: input.summaryMessages,
    messagesToKeep: input.retainedMessages,
    attachments: input.minimalAttachments,
    hookResults: input.hookResults,
    preCompactTokenCount: input.preCompactTokenCount,
    postCompactTokenCount: input.postCompactTokenCount,
    truePostCompactTokenCount: input.truePostCompactTokenCount,
  }
}

export function createCodexStyleCompactionResultFromSummary(input: {
  originalMessages: Message[]
  boundaryMarker: SystemMessage
  summaryMessages: UserMessage[]
  hookResults: HookResultMessage[]
  options: CodexCompactOptions
  preCompactTokenCount?: number
  postCompactTokenCount?: number
}): CompactionResult {
  const truncatedMessages = truncateLargeToolResultsForCodexCompact(
    input.originalMessages,
  )
  const truncatedToolResultCount = countTruncatedToolResults(
    input.originalMessages,
    truncatedMessages,
  )
  const retained = selectRetainedMessagesForCodexCompact(
    truncatedMessages,
    input.options.retainedUserMessageTokens,
  )
  const metadata = buildCodexCompactMetadata({
    retainedMessageCount: retained.messages.length,
    retainedApproxTokens: retained.approxTokens,
    truncatedToolResultCount,
    droppedAttachmentCount: 0,
    retainedUserMessageTokens: input.options.retainedUserMessageTokens,
  })

  return buildCodexStyleCompactionResult({
    boundaryMarker: input.boundaryMarker,
    summaryMessages: input.summaryMessages,
    retainedMessages: retained.messages,
    minimalAttachments: [],
    hookResults: input.hookResults,
    preCompactTokenCount: input.preCompactTokenCount,
    postCompactTokenCount: input.postCompactTokenCount,
    truePostCompactTokenCount:
      (input.postCompactTokenCount ?? 0) + retained.approxTokens,
    metadata,
  })
}

export async function compactConversationCodexStyle(
  messages: Message[],
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  suppressFollowUpQuestions: boolean,
  customInstructions: string | undefined,
  isAutoCompact: boolean,
  options: CodexCompactOptions,
): Promise<CompactionResult> {
  const claudeResult = await compactConversation(
    messages,
    context,
    cacheSafeParams,
    suppressFollowUpQuestions,
    customInstructions,
    isAutoCompact,
  )

  const boundaryMarker = createCompactBoundaryMessage(
    isAutoCompact ? 'auto' : 'manual',
    claudeResult.preCompactTokenCount ?? 0,
    messages.at(-1)?.uuid,
  )

  return createCodexStyleCompactionResultFromSummary({
    originalMessages: messages,
    boundaryMarker,
    summaryMessages: claudeResult.summaryMessages,
    hookResults: claudeResult.hookResults,
    options,
    preCompactTokenCount: claudeResult.preCompactTokenCount,
    postCompactTokenCount: claudeResult.postCompactTokenCount,
  })
}
