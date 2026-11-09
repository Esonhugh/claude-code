import type { QuerySource } from '../../constants/querySource.js'
import type { Message } from '../../types/message.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { isPromptTooLongMessage } from '../api/errors.js'
import { autoCompactIfNeeded, isAutoCompactEnabled } from './autoCompact.js'
import type { CompactionResult } from './compact.js'

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
