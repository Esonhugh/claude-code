import type { QuerySource } from '../../constants/querySource.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import {
  isPromptTooLongMessage,
  parsePromptTooLongTokenCounts,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
} from '../api/errors.js'
import { roughTokenCountEstimationForMessages } from '../tokenEstimation.js'
import { autoCompactIfNeeded, isAutoCompactEnabled } from './autoCompact.js'
import type { CompactionResult } from './compact.js'
import { groupMessagesByApiRound } from './grouping.js'

/**
 * Official 2.1.319: when the API rejects a request as too long, compact the
 * conversation and retry the turn once instead of ending it. Follows the
 * user's auto-compact setting.
 */
export function isReactiveCompactEnabled(): boolean {
  return isAutoCompactEnabled()
}

export function isReactiveOnlyMode(): boolean {
  return false
}

export function isWithheldPromptTooLong(message: unknown): boolean {
  const candidate = message as Message | undefined
  return (
    candidate?.type === 'assistant' &&
    isPromptTooLongMessage(candidate) &&
    isReactiveCompactEnabled()
  )
}

export function isWithheldMediaSizeError(_message: unknown): boolean {
  return false
}

/**
 * Official: a conversation of a single API round has nothing to summarize, so
 * its prompt-too-long is reported with where the tokens are instead of being
 * compacted and refused again. Null when there is a round to compact.
 */
export function singleExchangePromptTooLong(
  refused: AssistantMessage,
  messages: Message[],
): AssistantMessage | null {
  const exchange = messages.filter(message => message.type !== 'progress')
  if (groupMessagesByApiRound(exchange).length >= 2) return null
  const { actualTokens, limitTokens } = parsePromptTooLongTokenCounts(
    refused.errorDetails ?? '',
  )
  // @ts-ignore - recovered code
  const conversationTokens = roughTokenCountEstimationForMessages(exchange)
  const detail =
    actualTokens === undefined || limitTokens === undefined
      ? 'this conversation is a single exchange and cannot be compacted — the request size comes mostly from system prompt, tool definitions, or attachments.'
      : conversationTokens >= actualTokens * 0.8
        ? `the request is ~${actualTokens} tokens (limit ${limitTokens}) and this conversation's own content is most of it. A single-exchange conversation cannot be compacted; start with less content (smaller files or pasted text).`
        : `the request is ~${actualTokens} tokens (limit ${limitTokens}) but this conversation is only ~${conversationTokens} tokens — the rest is system prompt, tool definitions, and attachment content. A single-exchange conversation cannot be compacted; reduce attached files/tools or start with less context.`
  return {
    ...refused,
    message: {
      ...refused.message,
      content: [
        { type: 'text', text: `${PROMPT_TOO_LONG_ERROR_MESSAGE} · ${detail}` },
      ],
    },
  } as AssistantMessage
}

export async function tryReactiveCompact(input: {
  hasAttempted: boolean
  querySource?: QuerySource
  aborted?: boolean
  messages: Message[]
  cacheSafeParams: CacheSafeParams
}): Promise<CompactionResult | null> {
  if (
    input.hasAttempted ||
    input.aborted ||
    input.querySource === 'compact' ||
    input.querySource === 'session_memory'
  ) {
    return null
  }
  const { compactionResult } = await autoCompactIfNeeded(
    input.messages,
    input.cacheSafeParams.toolUseContext,
    input.cacheSafeParams,
    input.querySource,
    undefined,
    0,
    undefined,
    true,
  )
  return compactionResult ?? null
}

export async function reactiveCompactOnPromptTooLong(
  _messages: unknown[],
  _cacheSafeParams: unknown,
  _options?: unknown,
): Promise<
  | {
      ok: true
      result: {
        messages: unknown[]
        summary: string
        userDisplayMessage?: string
      }
    }
  | {
      ok: false
      reason:
        | 'too_few_groups'
        | 'aborted'
        | 'exhausted'
        | 'error'
        | 'media_unstrippable'
    }
> {
  return {
    ok: false,
    reason: 'too_few_groups',
  }
}
