import { describe, expect, test } from 'bun:test'
import type { QuerySource } from './constants/querySource.js'
import type { ToolUseContext } from './Tool.js'
import type { AssistantMessage, Message } from './types/message.js'
import { query, type QueryParams } from './query.js'
import { autoCompactIfNeeded } from './services/compact/autoCompact.js'
import { asSystemPrompt } from './utils/systemPromptType.js'
import { createFileStateCacheWithSizeLimit } from './utils/fileStateCache.js'
import { getDefaultAppState, type AppState } from './state/AppStateStore.js'

function userMessage(content: string): Message {
  return {
    type: 'user',
    uuid: '00000000-0000-4000-8000-000000000001',
    timestamp: '2026-08-09T00:00:00.000Z',
    message: {
      role: 'user',
      content,
    },
  } as Message
}

function createToolUseContext(): ToolUseContext {
  let appState: AppState = getDefaultAppState()

  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'claude-sonnet-4-6',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: {
        activeAgents: [],
        allAgents: [],
        allowedAgentTypes: undefined,
      },
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(10),
    getAppState: () => appState,
    setAppState: updater => {
      appState = updater(appState)
    },
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [],
  }
}

async function drainQuery(params: QueryParams): Promise<{
  events: Array<Message | { type: string }>
  terminal: unknown
}> {
  const events: Array<Message | { type: string }> = []
  const iterator = query(params)

  while (true) {
    const next = await iterator.next()
    if (next.done) {
      return { events, terminal: next.value }
    }
    events.push(next.value)
  }
}

function assistantText(message: AssistantMessage): string {
  return message.message.content
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('\n')
}

describe('query autocompact failures', () => {
  test('keeps OpenAI usage_limit_reached visible when autocompact fails before blocking-limit preempt', async () => {
    const previousBlockingLimit = process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE
    process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE = '1'

    const compactionFailure = {
      message: 'OpenAI 429 usage_limit_reached: usage limit reached',
    }
    let autocompactCalls = 0
    let callModelCalls = 0

    try {
      const { events, terminal } = await drainQuery({
        messages: [userMessage('enough text to exceed the test blocking limit')],
        systemPrompt: asSystemPrompt([]),
        userContext: {},
        systemContext: {},
        canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
        toolUseContext: createToolUseContext(),
        querySource: 'repl_main_thread' as QuerySource,
        deps: {
          uuid: () => '00000000-0000-4000-8000-000000000099',
          microcompact: async messages => ({ messages }),
          autocompact: async () => {
            autocompactCalls++
            return {
              wasCompacted: false,
              consecutiveFailures: 1,
              compactionFailure,
            }
          },
          callModel: async function* () {
            callModelCalls++
            throw new Error('callModel should not run after blocking-limit preempt')
          },
        },
      })

      const apiError = events.find(
        (event): event is AssistantMessage =>
          event.type === 'assistant' &&
          'isApiErrorMessage' in event &&
          event.isApiErrorMessage === true,
      )
      expect(autocompactCalls).toBe(1)
      expect(callModelCalls).toBe(0)
      expect(terminal).toEqual({ reason: 'blocking_limit' })
      expect(apiError).toBeDefined()

      const finalErrorDiagnostic = [
        assistantText(apiError!),
        String(apiError!.error ?? ''),
        apiError!.errorDetails ?? '',
        apiError!.apiError?.message ?? '',
      ].join('\n')

      expect(finalErrorDiagnostic).toContain('usage_limit_reached')
    } finally {
      if (previousBlockingLimit === undefined) {
        delete process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE
      } else {
        process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE = previousBlockingLimit
      }
    }
  })

  test('keeps Claude usage-limit text visible when autocompact fails before blocking-limit preempt', async () => {
    const previousBlockingLimit = process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE
    process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE = '1'

    const compactionFailure = {
      message: "You've hit your usage limit · resets 3pm",
    }
    let autocompactCalls = 0
    let callModelCalls = 0

    try {
      const { events, terminal } = await drainQuery({
        messages: [userMessage('enough text to exceed the test blocking limit')],
        systemPrompt: asSystemPrompt([]),
        userContext: {},
        systemContext: {},
        canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
        toolUseContext: createToolUseContext(),
        querySource: 'repl_main_thread' as QuerySource,
        deps: {
          uuid: () => '00000000-0000-4000-8000-000000000100',
          microcompact: async messages => ({ messages }),
          autocompact: async () => {
            autocompactCalls++
            return {
              wasCompacted: false,
              consecutiveFailures: 1,
              compactionFailure,
            }
          },
          callModel: async function* () {
            callModelCalls++
            throw new Error('callModel should not run after blocking-limit preempt')
          },
        },
      })

      const apiError = events.find(
        (event): event is AssistantMessage =>
          event.type === 'assistant' &&
          'isApiErrorMessage' in event &&
          event.isApiErrorMessage === true,
      )
      expect(autocompactCalls).toBe(1)
      expect(callModelCalls).toBe(0)
      expect(terminal).toEqual({ reason: 'blocking_limit' })
      expect(apiError).toBeDefined()

      const finalErrorDiagnostic = [
        assistantText(apiError!),
        String(apiError!.error ?? ''),
        apiError!.errorDetails ?? '',
        apiError!.apiError?.message ?? '',
      ].join('\n')

      expect(apiError!.error).toBe('rate_limit')
      expect(apiError!.errorDetails).toBe(compactionFailure.message)
      expect(apiError!.apiError).toMatchObject({
        status: 429,
        type: 'rate_limit_error',
        message: compactionFailure.message,
      })
      expect(finalErrorDiagnostic).toContain(compactionFailure.message)
      expect(finalErrorDiagnostic).not.toContain('Prompt is too long')
    } finally {
      if (previousBlockingLimit === undefined) {
        delete process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE
      } else {
        process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE = previousBlockingLimit
      }
    }
  })

  test('autoCompactIfNeeded returns typed failure message and preserves failure count on catch', async () => {
    const previousAutoCompactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '1'

    const toolUseContext = createToolUseContext()

    try {
      const result = await autoCompactIfNeeded(
        [],
        toolUseContext,
        {
          systemPrompt: asSystemPrompt([]),
          userContext: {},
          systemContext: {},
          toolUseContext,
          forkContextMessages: [],
        },
        'repl_main_thread' as QuerySource,
        {
          compacted: false,
          turnCounter: 0,
          turnId: '00000000-0000-4000-8000-000000000010',
          consecutiveFailures: 1,
        },
      )

      expect(result.wasCompacted).toBe(false)
      expect(result.consecutiveFailures).toBe(2)
      expect(result.compactionFailure).toEqual({
        message: 'Not enough messages to compact.',
      })
    } finally {
      if (previousAutoCompactWindow === undefined) {
        delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
      } else {
        process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = previousAutoCompactWindow
      }
    }
  })
})
