import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { StopHookInput } from './entrypoints/agentSdkTypes.js'
import type { QuerySource } from './constants/querySource.js'
import type { ToolUseContext } from './Tool.js'
import type { AssistantMessage, Message } from './types/message.js'
import { query, type QueryParams } from './query.js'
import type { QueryDeps } from './query/deps.js'
import { autoCompactIfNeeded, getAutoCompactThreshold } from './services/compact/autoCompact.js'
import * as config from './utils/config.js'
import * as tokens from './utils/tokens.js'
import * as compactMode from './services/compact/compactMode.js'
import * as sessionMemory from './services/compact/sessionMemoryCompact.js'
import { asSystemPrompt } from './utils/systemPromptType.js'
import { createFileStateCacheWithSizeLimit } from './utils/fileStateCache.js'
import { createAssistantAPIErrorMessage, createAssistantMessage } from './utils/messages.js'
import { getDefaultAppState, type AppState } from './state/AppStateStore.js'
import {
  registerHookCallbacks,
  resetStateForTests,
} from './bootstrap/state.js'

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

type StopHookTestOptions = {
  maxTurns?: number
  stopHookActive?: boolean
  hookResults?: boolean[]
  includeToolRound?: boolean
}

async function runStopHookQuery({
  maxTurns,
  stopHookActive,
  hookResults = [],
  includeToolRound = false,
}: StopHookTestOptions = {}) {
  const observedInputs: StopHookInput[] = []
  let hookCall = 0
  let modelCall = 0

  registerHookCallbacks({
    Stop: [
      {
        hooks: [
          {
            type: 'callback',
            callback: async input => {
              observedInputs.push(input as StopHookInput)
              const shouldPass = hookResults[hookCall++] ?? false
              return shouldPass
                ? { continue: true }
                : { decision: 'block', reason: 'work remains' }
            },
          },
        ],
      },
    ],
  })

  const toolUseContext = createToolUseContext()
  return {
    observedInputs,
    modelCalls: () => modelCall,
    result: await drainQuery({
      messages: [userMessage('finish the task')],
      systemPrompt: asSystemPrompt([]),
      userContext: {},
      systemContext: {},
      canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      toolUseContext,
      querySource: 'repl_main_thread' as QuerySource,
      maxTurns,
      stopHookActive,
      deps: {
        uuid: () => `00000000-0000-4000-8000-${String(modelCall).padStart(12, '0')}`,
        microcompact: async messages => ({ messages }),
        autocompact: async messages => ({ messages, wasCompacted: false }),
        callModel: async function* () {
          modelCall++
          if (includeToolRound && modelCall === 2) {
            yield createAssistantMessage({
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_reset_block_count',
                  name: 'missing_test_tool',
                  input: {},
                },
              ],
            })
            return
          }
          yield createAssistantMessage({ content: `model round ${modelCall}` })
        },
      },
    }),
  }
}

beforeEach(() => {
  resetStateForTests()
})

describe('query Stop hook continuation state', () => {
  test('passes initial and retry stop_hook_active values to hooks', async () => {
    const run = await runStopHookQuery({ hookResults: [false, true] })

    expect(run.result.terminal).toEqual({ reason: 'completed' })
    expect(run.modelCalls()).toBe(2)
    expect(run.observedInputs.map(input => input.stop_hook_active)).toEqual([
      false,
      true,
    ])
  })

  test('honors initial stopHookActive from QueryParams', async () => {
    const run = await runStopHookQuery({
      stopHookActive: true,
      hookResults: [true],
    })

    expect(run.result.terminal).toEqual({ reason: 'completed' })
    expect(run.observedInputs[0]?.stop_hook_active).toBe(true)
  })

  test('maxTurns takes precedence over the consecutive block cap', async () => {
    const previousCap = process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
    process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP = '1'
    try {
      const run = await runStopHookQuery({ maxTurns: 1 })

      expect(run.modelCalls()).toBe(1)
      expect(run.result.terminal).toEqual({ reason: 'max_turns', turnCount: 2 })
      expect(
        run.result.events.some(
          event =>
            event.type === 'attachment' &&
            'attachment' in event &&
            event.attachment.type === 'max_turns_reached',
        ),
      ).toBe(true)
    } finally {
      if (previousCap === undefined) {
        delete process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
      } else {
        process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP = previousCap
      }
    }
  })

  test('default cap overrides the ninth consecutive block', async () => {
    const previousCap = process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
    delete process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
    try {
      const run = await runStopHookQuery()

      expect(run.modelCalls()).toBe(9)
      expect(run.observedInputs).toHaveLength(9)
      expect(run.result.terminal).toEqual({ reason: 'completed' })
      expect(
        run.result.events.some(
          event =>
            event.type === 'system' &&
            'content' in event &&
            event.content.includes(
              'blocked the turn from ending 9 consecutive times',
            ),
        ),
      ).toBe(true)
    } finally {
      if (previousCap === undefined) {
        delete process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
      } else {
        process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP = previousCap
      }
    }
  })

  test('environment cap override limits consecutive blocks', async () => {
    const previousCap = process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
    process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP = '2'
    try {
      const run = await runStopHookQuery()

      expect(run.modelCalls()).toBe(3)
      expect(run.result.terminal).toEqual({ reason: 'completed' })
    } finally {
      if (previousCap === undefined) {
        delete process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
      } else {
        process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP = previousCap
      }
    }
  })

  test.each(['0', '-1'])('cap %s disables the consecutive block override', async cap => {
    const previousCap = process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
    process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP = cap
    try {
      const run = await runStopHookQuery({
        maxTurns: 3,
        hookResults: [false, false, false],
      })

      expect(run.modelCalls()).toBe(3)
      expect(run.result.terminal).toEqual({ reason: 'max_turns', turnCount: 4 })
    } finally {
      if (previousCap === undefined) {
        delete process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
      } else {
        process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP = previousCap
      }
    }
  })

  test('a normal tool round resets the consecutive block count', async () => {
    const previousCap = process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
    process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP = '1'
    try {
      const run = await runStopHookQuery({
        hookResults: [false, false, true],
        includeToolRound: true,
      })

      expect(run.modelCalls()).toBe(4)
      expect(run.result.terminal).toEqual({ reason: 'completed' })
      expect(run.observedInputs.map(input => input.stop_hook_active)).toEqual([
        false,
        true,
        true,
      ])
    } finally {
      if (previousCap === undefined) {
        delete process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
      } else {
        process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP = previousCap
      }
    }
  })
})

describe('query autocompact failures', () => {
  test('stops the turn when autocompact keeps refilling (2.1.319 rapid-refill breaker)', async () => {
    let callModelCalls = 0
    const { events, terminal } = await drainQuery({
      messages: [userMessage('hello')],
      systemPrompt: asSystemPrompt([]),
      userContext: {},
      systemContext: {},
      canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      toolUseContext: createToolUseContext(),
      querySource: 'repl_main_thread' as QuerySource,
      deps: {
        uuid: () => '00000000-0000-4000-8000-000000000098',
        microcompact: async messages => ({ messages }),
        autocompact: async () => ({
          wasCompacted: false,
          rapidRefillBreakerTripped: true,
        }),
        callModel: async function* () {
          callModelCalls++
          yield await Promise.reject(new Error('callModel should not run'))
        },
      },
    })
    const apiError = events.find(
      (event): event is AssistantMessage =>
        event.type === 'assistant' &&
        'isApiErrorMessage' in event &&
        event.isApiErrorMessage === true,
    )
    expect(callModelCalls).toBe(0)
    expect(terminal).toEqual({ reason: 'rapid_refill_breaker' })
    expect(assistantText(apiError!)).toContain('Autocompact is thrashing')
  })

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
            yield await Promise.reject(
              new Error('callModel should not run after blocking-limit preempt'),
            )
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
            yield await Promise.reject(
              new Error('callModel should not run after blocking-limit preempt'),
            )
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

  test('an autocompact interrupted by the user does not surface Prompt is too long', async () => {
    const previousBlockingLimit = process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE
    process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE = '1'
    const toolUseContext = createToolUseContext()

    try {
      const { events, terminal } = await drainQuery({
        messages: [userMessage('enough text to exceed the test blocking limit')],
        systemPrompt: asSystemPrompt([]),
        userContext: {},
        systemContext: {},
        canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
        toolUseContext,
        querySource: 'repl_main_thread' as QuerySource,
        deps: {
          uuid: () => '00000000-0000-4000-8000-000000000101',
          microcompact: async messages => ({ messages }),
          autocompact: async () => {
            // Esc while the summary request is in flight.
            toolUseContext.abortController.abort('user-cancel')
            return { wasCompacted: false, consecutiveFailures: 1 }
          },
          callModel: async function* () {},
        },
      })

      const texts = events
        .filter((event): event is AssistantMessage => event.type === 'assistant')
        .map(assistantText)
      expect(texts.join('\n')).not.toContain('Prompt is too long')
      expect(terminal).not.toEqual({ reason: 'blocking_limit' })
    } finally {
      if (previousBlockingLimit === undefined) {
        delete process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE
      } else {
        process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE = previousBlockingLimit
      }
    }
  })

  test('autoCompactIfNeeded returns typed failure message and preserves failure count on catch', async () => {
    const envKeys = ['CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'DISABLE_COMPACT', 'DISABLE_AUTO_COMPACT'] as const
    const savedEnvironment = envKeys.map(key => process.env[key])
    // Window values below 100k are rejected. Force the catch path through the
    // measured-usage boundary, while keeping the real empty-message compactor.
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '100000'
    delete process.env.DISABLE_COMPACT
    delete process.env.DISABLE_AUTO_COMPACT
    const enabled = spyOn(config, 'getGlobalConfig').mockReturnValue({ ...config.getGlobalConfig(), autoCompactEnabled: true })
    const measuredUsage = spyOn(tokens, 'tokenCountWithEstimation').mockReturnValue(190000)
    const mode = spyOn(compactMode, 'getCompactMode').mockReturnValue('claude')
    const memory = spyOn(sessionMemory, 'trySessionMemoryCompaction').mockResolvedValue(null)

    try {
      const toolUseContext = createToolUseContext()
      expect(190000).toBeGreaterThan(getAutoCompactThreshold(toolUseContext.options.mainLoopModel))
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
      expect(measuredUsage).toHaveBeenCalledWith([], expect.any(Number))
    } finally {
      enabled.mockRestore()
      measuredUsage.mockRestore()
      mode.mockRestore()
      memory.mockRestore()
      envKeys.forEach((key, index) => {
        if (savedEnvironment[index] === undefined) delete process.env[key]
        else process.env[key] = savedEnvironment[index]
      })
    }
  })
})

describe('query streaming fallback tombstones', () => {
  function runFallback(items: (fallback: () => void) => AsyncGenerator<Message | { type: 'stream_event'; event: { type: string } }>) {
    return drainQuery({
      messages: [userMessage('say OK')],
      systemPrompt: asSystemPrompt([]),
      userContext: {},
      systemContext: {},
      canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      toolUseContext: createToolUseContext(),
      querySource: 'repl_main_thread' as QuerySource,
      deps: {
        uuid: () => '00000000-0000-4000-8000-000000000099',
        microcompact: async messages => ({ messages }),
        autocompact: async messages => ({ messages, wasCompacted: false }),
        callModel: (request => items(() => request.options.onStreamingFallback?.())) as QueryDeps['callModel'],
      },
    })
  }

  test('the fallback result is not tombstoned by stream events that follow it', async () => {
    const error = createAssistantAPIErrorMessage({ content: 'API Error: ENOENT' })
    const { events } = await runFallback(async function* (fallback) {
      yield { type: 'stream_event', event: { type: 'message_start' } }
      fallback()
      yield error
      // A turn.step mod closes the message it opened after the error item.
      yield { type: 'stream_event', event: { type: 'message_delta' } }
      yield { type: 'stream_event', event: { type: 'message_stop' } }
    })
    expect(events.filter(event => event.type === 'tombstone')).toEqual([])
    expect(events).toContain(error)
  })

  test('messages streamed before the fallback are still tombstoned once', async () => {
    const partial = createAssistantMessage({ content: 'partial' })
    const final = createAssistantMessage({ content: 'final' })
    const { events } = await runFallback(async function* (fallback) {
      yield partial
      fallback()
      yield final
      yield { type: 'stream_event', event: { type: 'message_stop' } }
    })
    const tombstones = events.filter(event => event.type === 'tombstone') as Array<{ message: Message }>
    expect(tombstones.map(t => t.message)).toEqual([partial])
  })
})
