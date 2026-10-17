import type { Message } from '../../types/message.js'
import type { Tools } from '../../Tool.js'
import {
  ensureToolResultPairing,
  getMessagesAfterCompactBoundary,
  normalizeMessagesForAPI,
} from '../../utils/messages.js'

type ToolResultSummary = {
  tool_use_id: string
  text: string
  isError: boolean
  result?: unknown
}
type ToolUseSummary = {
  tool_use_id: string
  tool: string
  input: unknown
  text?: string
  isError?: true
  result?: unknown
  agentId?: string
  durationMs?: number
}
export type ModApiMessage = {
  role: 'user' | 'assistant'
  content: { type: string; [field: string]: unknown }[]
}
export type ModSessionMessagesArgs = { agentId?: string; as?: 'api' }

export function validateModSessionMessagesArgs(
  value: unknown,
): asserts value is ModSessionMessagesArgs {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== 'agentId' && key !== 'as') ||
    ('agentId' in value &&
      value.agentId !== undefined &&
      typeof value.agentId !== 'string') ||
    ('as' in value && value.as !== undefined && value.as !== 'api')
  )
    throw new TypeError(
      'session.messages takes { agentId?: string, as?: "api" }',
    )
}

/** Normalize a private copy just as a request does; per-send cache marks are not exposed. */
export function projectModApiMessages(
  messages: readonly Message[],
  tools: Tools = [],
  limit = 4096,
): ModApiMessage[] {
  const copy = structuredClone([...messages])
  const normalized = ensureToolResultPairing(
    normalizeMessagesForAPI(getMessagesAfterCompactBoundary(copy), tools),
  )
  let recent = normalized.slice(-limit)
  while (recent[0]?.type === 'assistant') recent = recent.slice(1)
  return ensureToolResultPairing(recent).map((message) => ({
    role: message.type,
    content: (typeof message.message.content === 'string'
      ? [{ type: 'text', text: message.message.content }]
      : message.message.content
    ).map((block) => {
      const { cache_control: _cache, ...content } = block as {
        type: string
        cache_control?: unknown
        [field: string]: unknown
      }
      return content
    }),
  }))
}
export type ModSessionMessage = {
  role: 'user' | 'assistant'
  text: string
  toolUses: ToolUseSummary[]
  toolResults?: ToolResultSummary[]
}

/** The Mods transcript is data-only and excludes UI rows and hidden user context. */
export function projectModSessionMessages(
  messages: readonly Message[],
  limit = 4096,
  trackedAgents: ReadonlyMap<string, string> = new Map(),
): ModSessionMessage[] {
  const projected: ModSessionMessage[] = []
  const results = new Map<string, ToolResultSummary>()
  for (
    let index = messages.length - 1;
    index >= 0 && projected.length < limit;
    index--
  ) {
    const message = messages[index]!
    if (message.type !== 'user' && message.type !== 'assistant') continue
    if (message.type === 'user' && (message.isMeta || message.isVirtual))
      continue
    const content = message.message.content
    const summary: ModSessionMessage = {
      role: message.type,
      text: '',
      toolUses: [],
    }
    if (typeof content === 'string') summary.text = content
    else
      for (const block of content) {
        if (block.type === 'text') summary.text += block.text
        else if (block.type === 'tool_use' && message.type === 'assistant') {
          const result = results.get(block.id)
          const stored = result?.result
          const record =
            stored && typeof stored === 'object' && !Array.isArray(stored)
              ? (stored as Record<string, unknown>)
              : undefined
          const agentId =
            block.name === 'Agent'
              ? (trackedAgents.get(block.id) ??
                (!result?.isError &&
                typeof record?.agentId === 'string' &&
                record.agentId
                  ? record.agentId
                  : undefined))
              : undefined
          const completed =
            record?.status === 'completed' ||
            (record?.status === undefined &&
              Array.isArray(record?.content) &&
              typeof record?.totalTokens === 'number' &&
              typeof record?.totalToolUseCount === 'number' &&
              record?.usage &&
              typeof record.usage === 'object')
          const durationMs =
            agentId &&
            !result?.isError &&
            completed &&
            typeof record.totalDurationMs === 'number' &&
            Number.isFinite(record.totalDurationMs) &&
            record.totalDurationMs >= 0
              ? record.totalDurationMs
              : undefined
          summary.toolUses.push({
            tool_use_id: block.id,
            tool: block.name,
            input: structuredClone(block.input),
            ...(agentId === undefined ? {} : { agentId }),
            ...(durationMs === undefined ? {} : { durationMs }),
            ...(result
              ? {
                  text: result.text,
                  ...(result.isError ? { isError: true as const } : {}),
                  ...('result' in result ? { result: result.result } : {}),
                }
              : {}),
          })
        } else if (block.type === 'tool_result' && message.type === 'user') {
          const result: ToolResultSummary = {
            tool_use_id: block.tool_use_id,
            text:
              typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content
                      .flatMap((part) =>
                        part?.type === 'text' && typeof part.text === 'string'
                          ? [part.text]
                          : [],
                      )
                      .join('')
                  : '',
            isError: block.is_error === true,
            ...(message.toolUseResult === undefined
              ? {}
              : { result: structuredClone(message.toolUseResult) }),
          }
          ;(summary.toolResults ??= []).push(result)
          results.set(result.tool_use_id, result)
        }
      }
    projected.push(summary)
  }
  return projected.reverse()
}
