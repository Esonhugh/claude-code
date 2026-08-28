import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type {
  SDKControlReplayHistoryResponse,
  SSHHistoryChunk,
  SSHHistoryMessage,
} from '../entrypoints/sdk/controlTypes.js'
import { isGoalStatusAttachment } from '../commands/goal/types.js'
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from '../types/message.js'
import { normalizeMessages } from '../utils/messages.js'
import { toSDKCompactMetadata } from '../utils/messages/mappers.js'

const DEFAULT_MAX_MESSAGES_PER_CHUNK = 100
const DEFAULT_MAX_CHUNK_BYTES = 256 * 1024

export function projectSSHHistoryMessages(
  messages: readonly Message[],
  sessionId: string,
): SSHHistoryMessage[] {
  return messages.flatMap((message): SSHHistoryMessage[] => {
    if (
      message.type === 'progress' &&
      (message.data.type === 'agent_progress' ||
        message.data.type === 'skill_progress')
    ) {
      const nestedMessage = message.data.message as Message | undefined
      if (
        !nestedMessage ||
        (nestedMessage.type !== 'assistant' && nestedMessage.type !== 'user')
      ) {
        return []
      }

      const normalized = normalizeMessages([
        nestedMessage as AssistantMessage | UserMessage,
      ])
      return normalized.map(normalizedMessage => {
        if (normalizedMessage.type === 'assistant') {
          return {
            type: 'assistant',
            message: normalizedMessage.message,
            parent_tool_use_id: message.parentToolUseID,
            uuid: normalizedMessage.uuid,
            session_id: sessionId,
            timestamp: normalizedMessage.timestamp,
            ...(normalizedMessage.error
              ? { error: normalizedMessage.error }
              : {}),
          } as SSHHistoryMessage
        }

        return {
          type: 'user',
          message: normalizedMessage.message,
          parent_tool_use_id: message.parentToolUseID,
          uuid: normalizedMessage.uuid,
          session_id: sessionId,
          timestamp: normalizedMessage.timestamp,
          isSynthetic:
            normalizedMessage.isMeta ||
            normalizedMessage.isVisibleInTranscriptOnly,
          ...(normalizedMessage.toolUseResult !== undefined
            ? {
                tool_use_result: normalizedMessage.mcpMeta
                  ? {
                      content: normalizedMessage.toolUseResult,
                      ...normalizedMessage.mcpMeta,
                    }
                  : normalizedMessage.toolUseResult,
              }
            : {}),
        } as SSHHistoryMessage
      })
    }

    if (
      message.type === 'attachment' &&
      isGoalStatusAttachment(message.attachment)
    ) {
      return [
        {
          type: 'system',
          subtype: 'goal_state_changed',
          goal: message.attachment,
          uuid: message.uuid,
          session_id: sessionId,
          timestamp: message.timestamp,
        } as SSHHistoryMessage,
      ]
    }

    if (message.type === 'user') {
      if (message.isVisibleInTranscriptOnly || message.isVirtual) return []
      return [
        {
          type: 'user',
          message: message.message,
          parent_tool_use_id: null,
          uuid: message.uuid,
          session_id: sessionId,
          timestamp: message.timestamp,
          isSynthetic: message.isMeta,
          isReplay: true,
          ...(message.toolUseResult !== undefined
            ? { tool_use_result: message.toolUseResult }
            : {}),
        } as SSHHistoryMessage,
      ]
    }

    if (message.type === 'assistant') {
      if (message.isVirtual) return []
      return [
        {
          type: 'assistant',
          message: message.message,
          parent_tool_use_id: null,
          uuid: message.uuid,
          session_id: sessionId,
          timestamp: message.timestamp,
          ...(message.error ? { error: message.error } : {}),
        } as SSHHistoryMessage,
      ]
    }

    if (
      message.type === 'system' &&
      message.subtype === 'compact_boundary' &&
      message.compactMetadata
    ) {
      return [
        {
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: toSDKCompactMetadata(message.compactMetadata),
          uuid: message.uuid,
          session_id: sessionId,
          timestamp: message.timestamp,
        } as SSHHistoryMessage,
      ]
    }

    return []
  })
}

export function buildSSHHistoryReplay(
  messages: readonly Message[],
  options: {
    requestId: string
    sessionId: string
    maxMessagesPerChunk?: number
    maxChunkBytes?: number
  },
): {
  chunks: SSHHistoryChunk[]
  response: SDKControlReplayHistoryResponse
} {
  const projected = projectSSHHistoryMessages(messages, options.sessionId)
  const maxMessages = options.maxMessagesPerChunk ?? DEFAULT_MAX_MESSAGES_PER_CHUNK
  const maxBytes = options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES
  const chunks: SSHHistoryChunk[] = []
  let current: SSHHistoryMessage[] = []

  const flush = () => {
    if (current.length === 0) return
    chunks.push({
      type: 'ssh_history_chunk',
      request_id: options.requestId,
      sequence: chunks.length,
      messages: current,
    })
    current = []
  }

  for (const message of projected) {
    const singleBytes = Buffer.byteLength(JSON.stringify([message]))
    if (singleBytes > maxBytes) {
      throw new Error('SSH history message exceeds chunk byte limit')
    }
    const candidate = [...current, message]
    if (
      current.length > 0 &&
      (candidate.length > maxMessages ||
        Buffer.byteLength(JSON.stringify(candidate)) > maxBytes)
    ) {
      flush()
    }
    current.push(message)
  }
  flush()

  const last = projected.at(-1) as (SDKMessage & { uuid?: string }) | undefined
  return {
    chunks,
    response: {
      session_id: options.sessionId,
      count: projected.length,
      ...(last?.uuid ? { last_uuid: last.uuid } : {}),
    },
  }
}
