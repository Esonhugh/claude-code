import type {
  AttachmentMessage,
  HookResultMessage,
  Message,
  SystemCompactBoundaryMessage,
  SystemMessage,
  UserMessage,
} from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { isHumanTurn } from '../../utils/messagePredicates.js'
import { createCompactBoundaryMessage } from '../../utils/messages.js'
import { extractDiscoveredToolNames } from '../../utils/toolSearch.js'
import { roughTokenCountEstimation } from '../tokenEstimation.js'
import type {
  CompactionResult,
  RemoteCompactionResult,
} from './compact.js'
import { compactConversation } from './compact.js'
import type { CodexCompactOptions } from './compactMode.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { getAnthropicClient } from '../api/client.js'
import { createOpenAITurnScope } from '../api/openai-turn-scope.js'
import { serializeOpenAIInstructions } from '../api/openai-compat.js'

export type CodexCompactMetadata = {
  mode: 'codex'
  retainedMessageCount: number
  retainedApproxTokens: number
  droppedAttachmentCount: number
  retainedUserMessageTokens: number
}

export function buildCodexCompactMetadata(input: {
  retainedMessageCount: number
  retainedApproxTokens: number
  droppedAttachmentCount: number
  retainedUserMessageTokens: number
}): CodexCompactMetadata {
  return {
    mode: 'codex',
    retainedMessageCount: input.retainedMessageCount,
    retainedApproxTokens: input.retainedApproxTokens,
    droppedAttachmentCount: input.droppedAttachmentCount,
    retainedUserMessageTokens: input.retainedUserMessageTokens,
  }
}

function isRetainableUserMessage(message: Message): message is UserMessage {
  if (
    !isHumanTurn(message) ||
    message.isCompactSummary ||
    message.isVisibleInTranscriptOnly
  ) {
    return false
  }
  const content = message.message.content
  return (
    typeof content === 'string' ||
    !content.some(block => block.type === 'tool_result')
  )
}

function userMessageText(message: UserMessage): string {
  const content = message.message.content
  if (typeof content === 'string') return content
  return content
    .flatMap(block => (block.type === 'text' ? [block.text] : []))
    .join('\n')
}

// Like Codex, only the user's own messages survive verbatim. Assistant turns,
// tool calls and tool output are left to the summary, so large Write inputs
// or tool results never stay in context. The message that overflows the
// budget keeps the head of its text; images and documents are dropped.
export function selectRetainedMessagesForCodexCompact(
  messages: Message[],
  retainedUserMessageTokens: number,
): { messages: Message[]; approxTokens: number } {
  const retained: Message[] = []
  let remaining = retainedUserMessageTokens

  for (let i = messages.length - 1; i >= 0 && remaining > 0; i--) {
    const message = messages[i]
    if (!message || !isRetainableUserMessage(message)) continue
    const text = userMessageText(message)
    if (!text) continue
    const tokens = roughTokenCountEstimation(text)
    const content = message.message.content
    const textOnly =
      typeof content === 'string' || content.every(block => block.type === 'text')
    retained.push(
      tokens <= remaining && textOnly
        ? message
        : {
            ...message,
            message: {
              ...message.message,
              content: tokens <= remaining ? text : text.slice(0, remaining * 4),
            },
          },
    )
    remaining -= Math.min(tokens, remaining)
  }

  return {
    messages: retained.reverse(),
    approxTokens: retainedUserMessageTokens - remaining,
  }
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
        provider: 'openai',
        preCompactTokens: input.preCompactTokenCount ?? 0,
        postCompactTokens: input.truePostCompactTokenCount ?? 0,
        compactionCallTokens: input.postCompactTokenCount ?? 0,
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
  attachments: AttachmentMessage[]
  hookResults: HookResultMessage[]
  options: CodexCompactOptions
  preCompactTokenCount?: number
  postCompactTokenCount?: number
}): CompactionResult {
  const retained = selectRetainedMessagesForCodexCompact(
    input.originalMessages,
    input.options.retainedUserMessageTokens,
  )
  // The deferred tool list is the only way the model learns what ToolSearch
  // can load, so it survives even when the other attachments are dropped.
  const minimalAttachments = input.options.keepPostCompactAttachments
    ? input.attachments
    : input.attachments.filter(
        message => message.attachment.type === 'deferred_tools_delta',
      )
  const metadata = buildCodexCompactMetadata({
    retainedMessageCount: retained.messages.length,
    retainedApproxTokens: retained.approxTokens,
    droppedAttachmentCount: input.attachments.length - minimalAttachments.length,
    retainedUserMessageTokens: input.options.retainedUserMessageTokens,
  })
  // A new boundary: carry the loaded deferred tools like compact.ts does,
  // since their tool_reference blocks may be summarized away.
  const discovered = extractDiscoveredToolNames(input.originalMessages)
  const boundaryMarker =
    discovered.size > 0
      ? ({
          ...input.boundaryMarker,
          compactMetadata: {
            ...((input.boundaryMarker as { compactMetadata?: Record<string, unknown> })
              .compactMetadata ?? {}),
            preCompactDiscoveredTools: [...discovered].sort(),
          },
        } as SystemMessage)
      : input.boundaryMarker

  return buildCodexStyleCompactionResult({
    boundaryMarker,
    summaryMessages: input.summaryMessages,
    retainedMessages: retained.messages,
    minimalAttachments,
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
  const previousOpenAICompaction = messages.findLast(
    (message): message is SystemCompactBoundaryMessage =>
      message.type === 'system' &&
      message.subtype === 'compact_boundary' &&
      Boolean(message.openAICompaction),
  )?.openAICompaction
  const openAITurnScope =
    getAPIProvider() === 'openai'
      ? (context.openAITurnScope ?? createOpenAITurnScope(context.agentId))
      : undefined
  const remoteCompact = openAITurnScope
    ? async (
        hookInstructions?: string,
      ): Promise<RemoteCompactionResult | undefined> => {
        const client = await getAnthropicClient({
          maxRetries: 0,
          model: context.options.mainLoopModel,
          source: 'compact',
          openAITurnScope,
        })
        const compact = (client.beta.messages as unknown as {
          compact?: (
            params: Record<string, unknown>,
            requestOptions?: { signal?: AbortSignal },
          ) => Promise<{
            item: {
              type: 'compaction'
              encrypted_content: string
              id?: string
            }
            usage: RemoteCompactionResult['usage']
          }>
        }).compact
        if (!compact) return undefined
        try {
          const systemInstructions = serializeOpenAIInstructions(
            cacheSafeParams.systemPrompt,
          )
          return await compact(
            {
              model: context.options.mainLoopModel,
              messages: messages
                .filter(
                  (message): message is Extract<
                    Message,
                    { type: 'user' | 'assistant' }
                  > =>
                    message.type === 'assistant' ||
                    (message.type === 'user' &&
                      // The previous compaction item stands in for its summary row.
                      !(previousOpenAICompaction && message.isCompactSummary)),
                )
                .map(message => message.message),
              system: systemInstructions,
              instructions: serializeOpenAIInstructions(
                systemInstructions,
                hookInstructions,
              ),
              ...(previousOpenAICompaction && {
                openai_compaction: previousOpenAICompaction,
              }),
            },
            { signal: context.abortController.signal },
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (/WebSocket \d+|OpenAI API (404|405|426)|not supported/i.test(message)) {
            return undefined
          }
          throw error
        }
      }
      : undefined

  const claudeResult = await compactConversation(
    messages,
    context,
    cacheSafeParams,
    suppressFollowUpQuestions,
    customInstructions,
    isAutoCompact,
    undefined,
    remoteCompact,
  )

  if (
    claudeResult.boundaryMarker.subtype === 'compact_boundary' &&
    claudeResult.boundaryMarker.openAICompaction
  ) {
    claudeResult.boundaryMarker.compactMetadata = {
      ...claudeResult.boundaryMarker.compactMetadata,
      mode: 'codex',
      provider: 'openai',
      preCompactTokens: claudeResult.preCompactTokenCount ?? 0,
      postCompactTokens: claudeResult.truePostCompactTokenCount ?? 0,
      compactionCallTokens: claudeResult.postCompactTokenCount ?? 0,
      ...(claudeResult.boundaryMarker.openAICompaction.id && {
        compactionResponseId:
          claudeResult.boundaryMarker.openAICompaction.id,
      }),
    }
    return claudeResult
  }

  const boundaryMarker = createCompactBoundaryMessage(
    isAutoCompact ? 'auto' : 'manual',
    claudeResult.preCompactTokenCount ?? 0,
    messages.at(-1)?.uuid,
  )

  return createCodexStyleCompactionResultFromSummary({
    originalMessages: messages,
    boundaryMarker,
    summaryMessages: claudeResult.summaryMessages,
    attachments: claudeResult.attachments,
    hookResults: claudeResult.hookResults,
    options,
    preCompactTokenCount: claudeResult.preCompactTokenCount,
    postCompactTokenCount: claudeResult.postCompactTokenCount,
  })
}
