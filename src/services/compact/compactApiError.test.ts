#!/usr/bin/env bun
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'

const PROMPT_TOO_LONG_ERROR_MESSAGE = 'Prompt is too long'
const USAGE_LIMIT_MESSAGE = "You've hit your usage limit"
let streamAssistantMessages: AssistantMessage[] = []
let streamCallCount = 0

mock.module('../api/claude.js', () => ({
  getMaxOutputTokensForModel: () => 4096,
  queryModelWithStreaming: () =>
    (async function* () {
      streamCallCount++
      const message = streamAssistantMessages.shift()
      if (!message) {
        throw new Error('test did not configure streamAssistantMessages')
      }
      yield message
    })(),
}))

mock.module('../../utils/forkedAgent.js', () => ({
  runForkedAgent: async () => {
    throw new Error('force direct streaming fallback')
  },
}))

mock.module('../analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: (_feature: string, defaultValue: unknown) =>
    defaultValue,
}))

mock.module('../../utils/hooks.js', () => ({
  executePreCompactHooks: async () => ({
    newCustomInstructions: undefined,
    userDisplayMessage: undefined,
  }),
  executePostCompactHooks: async () => ({ userDisplayMessage: undefined }),
}))

mock.module('../../utils/sessionStart.js', () => ({
  processSessionStartHooks: async () => [],
}))

mock.module('../../utils/sessionStorage.js', () => ({
  getTranscriptPath: () => '/tmp/compact-test-transcript.jsonl',
  reAppendSessionMetadata: () => {},
}))

mock.module('../../utils/log.js', () => ({
  logError: () => {},
}))

mock.module('../../utils/debug.js', () => ({
  logForDebugging: () => {},
}))

mock.module('../analytics/index.js', () => ({
  logEvent: () => {},
}))

mock.module('../internalLogging.js', () => ({
  logPermissionContextForAnts: () => {},
}))

mock.module('../../utils/sessionActivity.js', () => ({
  isSessionActivityTrackingActive: () => false,
  sendSessionActivitySignal: () => {},
}))

mock.module('../../utils/plans.js', () => ({
  getPlan: () => null,
  getPlanFilePath: () => '/tmp/compact-test-plan.md',
}))

const { compactConversation } = await import('./compact.js')

beforeEach(() => {
  streamAssistantMessages = []
  streamCallCount = 0
})

function userTextMessage(uuid: string, text: string): Message {
  return {
    type: 'user',
    uuid,
    timestamp: '2026-06-23T00:00:00.000Z',
    message: {
      role: 'user',
      content: text,
    },
  } as Message
}

function assistantTextMessage(uuid: string, id: string, text: string): AssistantMessage {
  return {
    type: 'assistant',
    uuid,
    timestamp: '2026-06-23T00:00:00.000Z',
    message: {
      id,
      role: 'assistant',
      model: 'claude-test',
      content: [{ type: 'text', text }],
      stop_reason: 'stop_sequence',
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  } as AssistantMessage
}

function assistantApiErrorMessage(text: string): AssistantMessage {
  return {
    ...assistantTextMessage(
      '00000000-0000-4000-8000-0000000000e1',
      'msg_api_error',
      text,
    ),
    isApiErrorMessage: true,
    errorDetails: text,
  } as AssistantMessage
}

function createCompactTestContext(): ToolUseContext {
  const appState = getDefaultAppState()
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'claude-sonnet-4-5-20250929',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(10),
    getAppState: () => appState,
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as unknown as ToolUseContext
}

function createCacheSafeParams(
  context: ToolUseContext,
  messages: Message[],
): CacheSafeParams {
  return {
    systemPrompt: [],
    userContext: {},
    systemContext: {},
    toolUseContext: context,
    forkContextMessages: messages,
  } as unknown as CacheSafeParams
}

describe('compactConversation remote compaction lifecycle', () => {
  test('preserves lifecycle output while storing the opaque compaction item', async () => {
    const messages = [
      userTextMessage(
        '00000000-0000-4000-8000-000000000011',
        'compact this conversation remotely',
      ),
    ]
    const context = createCompactTestContext()
    context.readFileState.set('/tmp/read-before-compact.txt', {
      content: 'read content',
      timestamp: 1,
    } as never)

    const result = await compactConversation(
      messages,
      context,
      createCacheSafeParams(context, messages),
      false,
      undefined,
      false,
      undefined,
      async () => ({
        item: {
          type: 'compaction',
          id: 'cmp_1',
          encrypted_content: 'opaque-state',
        },
        usage: {
          input_tokens: 100,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 20,
          server_tool_use: {
            web_search_requests: 0,
            web_fetch_requests: 0,
          },
          service_tier: 'standard',
          cache_creation: {
            ephemeral_1h_input_tokens: 0,
            ephemeral_5m_input_tokens: 0,
          },
        } as never,
      }),
    )

    expect(result.boundaryMarker.subtype).toBe('compact_boundary')
    if (result.boundaryMarker.subtype !== 'compact_boundary') return
    expect(result.boundaryMarker.openAICompaction).toEqual({
      type: 'compaction',
      id: 'cmp_1',
      encrypted_content: 'opaque-state',
    })
    expect(result.summaryMessages).toEqual([])
    expect(result.postCompactTokenCount).toBe(125)
    expect(result.compactionUsage?.cache_read_input_tokens).toBe(20)
    expect(context.readFileState.size).toBe(0)
  })

  test('uses local summary generation when remote compaction is unsupported', async () => {
    streamAssistantMessages = [
      assistantTextMessage(
        '00000000-0000-4000-8000-000000000012',
        'msg_local_summary',
        'local fallback summary',
      ),
    ]
    const messages = [
      userTextMessage(
        '00000000-0000-4000-8000-000000000013',
        'compact with fallback',
      ),
    ]
    const context = createCompactTestContext()

    const result = await compactConversation(
      messages,
      context,
      createCacheSafeParams(context, messages),
      false,
      undefined,
      false,
      undefined,
      async () => undefined,
    )

    expect(streamCallCount).toBe(1)
    expect(JSON.stringify(result.summaryMessages)).toContain(
      'local fallback summary',
    )
  })
})

describe('compactConversation direct streaming fallback API errors', () => {
  test('rejects API error assistant messages without API Error prefix', async () => {
    streamAssistantMessages = [assistantApiErrorMessage(USAGE_LIMIT_MESSAGE)]
    const messages = [
      userTextMessage(
        '00000000-0000-4000-8000-000000000001',
        'summarize this conversation',
      ),
    ]
    const context = createCompactTestContext()

    await expect(
      compactConversation(
        messages,
        context,
        createCacheSafeParams(context, messages),
        false,
      ),
    ).rejects.toThrow(USAGE_LIMIT_MESSAGE)
  })

  test('returns prompt-too-long API errors to the compact retry loop', async () => {
    streamAssistantMessages = [
      assistantApiErrorMessage(
        `${PROMPT_TOO_LONG_ERROR_MESSAGE}: 200 tokens > 100 maximum`,
      ),
      assistantTextMessage(
        '00000000-0000-4000-8000-0000000000e2',
        'msg_summary',
        'compact summary after retry',
      ),
    ]
    const messages = [
      userTextMessage('00000000-0000-4000-8000-000000000001', 'old context'),
      assistantTextMessage(
        '00000000-0000-4000-8000-000000000002',
        'msg_old',
        'old answer',
      ),
      userTextMessage('00000000-0000-4000-8000-000000000003', 'new request'),
    ]
    const context = createCompactTestContext()

    const result = await compactConversation(
      messages,
      context,
      createCacheSafeParams(context, messages),
      false,
    )

    expect(streamCallCount).toBe(2)
    expect(JSON.stringify(result.summaryMessages)).toContain(
      'compact summary after retry',
    )
  })
})
