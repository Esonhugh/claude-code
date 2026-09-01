import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
} from '../../types/message.js'
import {
  GOAL_HOOK_ID,
  type GoalStatusAttachment,
} from '../../commands/goal/types.js'
import { asAgentId } from '../../types/ids.js'
import type { AppState } from '../../state/AppState.js'
import type { PromptHook } from '../settings/types.js'

let hookResponse: {
  ok: boolean
  reason: string
  impossible?: boolean
} = { ok: false, reason: 'work remains' }
const claudeApi = await import('../../services/api/claude.js')
type HookQuery = Parameters<typeof claudeApi.queryModelWithoutStreaming>[0]
const hookQueries: HookQuery[] = []
const queuedResponses: AssistantMessage[] = []

function assistantResponse(
  content: string,
  isApiErrorMessage = false,
): AssistantMessage {
  return {
    type: 'assistant',
    uuid: '00000000-0000-4000-8000-000000000101',
    timestamp: '2026-08-31T00:00:00.000Z',
    isApiErrorMessage,
    message: {
      id: 'msg_hook_response',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-test',
      content: [{ type: 'text', text: content }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  } as unknown as AssistantMessage
}

mock.module('../../services/api/claude.js', () => ({
  ...claudeApi,
  queryModelWithoutStreaming: async (params: HookQuery) => {
    hookQueries.push(params)
    return (
      queuedResponses.shift() ?? assistantResponse(JSON.stringify(hookResponse))
    )
  },
}))

const { execPromptHook } = await import('./execPromptHook.js')
const { HookCommandSchema } = await import('../../schemas/hooks.js')
const { getSessionId, registerHookCallbacks, resetStateForTests } =
  await import('../../bootstrap/state.js')
const { clearGoal, registerGoalStopHook } =
  await import('../../commands/goal/hooks.js')
const { createActiveGoalStatus } = await import('../../commands/goal/state.js')
const { handleStopHooks } = await import('../../query/stopHooks.js')
const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } =
  await import('../fileStateCache.js')
const { addSessionHook, getSessionHooks, removeSessionHook } =
  await import('./sessionHooks.js')
const { executePostToolHooks } = await import('../hooks.js')
const { createAssistantMessage } = await import('../messages.js')
const { asSystemPrompt } = await import('../systemPromptType.js')

const hook: PromptHook = {
  type: 'prompt',
  prompt: 'Check this condition: $ARGUMENTS',
}

const context = {
  options: {
    tools: [],
  },
  getAppState: () => ({
    toolPermissionContext: {},
  }),
  setResponseLength: () => {},
} as unknown as ToolUseContext

beforeEach(() => {
  resetStateForTests()
  hookResponse = { ok: false, reason: 'work remains' }
  hookQueries.length = 0
  queuedResponses.length = 0
})

function createStopHookContext(
  initialGoal = createActiveGoalStatus(
    'goal-stop-hooks',
    'finish tests',
    1000,
    10,
  ),
) {
  let appState = {
    ...getDefaultAppState(),
    goalStatus: initialGoal,
  } as AppState
  const notifications: string[] = []
  const toolUseContext = {
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
    setAppState: (updater: (prev: AppState) => AppState) => {
      appState = updater(appState)
    },
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    addNotification: (notification: { text: string }) => {
      notifications.push(notification.text)
    },
    messages: [],
  } as unknown as ToolUseContext

  return {
    toolUseContext,
    getState: () => appState,
    setTask: (task: AppState['tasks'][string]) => {
      appState = { ...appState, tasks: { [task.id]: task } }
    },
    notifications,
  }
}

async function drainStopHooks(toolUseContext: ToolUseContext) {
  const events: Message[] = []
  const iterator = handleStopHooks(
    [],
    [createAssistantMessage({ content: 'final answer' })],
    asSystemPrompt([]),
    {},
    {},
    toolUseContext,
    'repl_main_thread',
    false,
  )
  while (true) {
    const next = await iterator.next()
    if (next.done) return { events, terminal: next.value }
    events.push(next.value as Message)
  }
}

function goalAttachments(events: Message[]): GoalStatusAttachment[] {
  return events.flatMap((message) =>
    message.type === 'attachment' && message.attachment.type === 'goal_status'
      ? [message.attachment]
      : [],
  )
}

describe('handleStopHooks Goal lifecycle', () => {
  test('Goal block updates state and yields one active attachment without a hook error notification', async () => {
    const testContext = createStopHookContext()
    registerGoalStopHook({
      setAppState: testContext.toolUseContext.setAppState,
      sessionId: getSessionId(),
      goalId: 'goal-stop-hooks',
      condition: 'finish tests',
      appendGoalStatusAttachment: () => {},
    })
    hookResponse = { ok: false, reason: 'one test remains' }

    const result = await drainStopHooks(testContext.toolUseContext)

    expect(result.terminal).toMatchObject({ preventContinuation: false })
    expect(result.terminal.blockingErrors).toHaveLength(1)
    expect(testContext.getState().goalStatus).toMatchObject({
      active: true,
      iterations: 1,
      lastReason: 'one test remains',
    })
    expect(goalAttachments(result.events)).toEqual([
      expect.objectContaining({
        status: 'active',
        iterations: 1,
        reason: 'one test remains',
      }),
    ])
    expect(testContext.notifications).toEqual([])
  })

  test('Goal success yields one terminal attachment and unregisters the hook', async () => {
    const testContext = createStopHookContext()
    registerGoalStopHook({
      setAppState: testContext.toolUseContext.setAppState,
      sessionId: getSessionId(),
      goalId: 'goal-stop-hooks',
      condition: 'finish tests',
      appendGoalStatusAttachment: () => {},
      now: () => 2000,
      currentTokens: () => 40,
    })
    hookResponse = { ok: true, reason: 'all tests pass' }

    const result = await drainStopHooks(testContext.toolUseContext)

    expect(result.terminal).toEqual({
      blockingErrors: [],
      preventContinuation: false,
    })
    expect(testContext.getState().goalStatus).toMatchObject({
      active: false,
      lastCompleted: {
        id: 'goal-stop-hooks',
        prompt: 'finish tests',
        status: 'met',
        iterations: 1,
        tokens: 0,
        reason: 'all tests pass',
      },
    })
    expect(goalAttachments(result.events)).toEqual([
      expect.objectContaining({
        status: 'met',
        iterations: 1,
        tokens: 0,
        reason: 'all tests pass',
      }),
    ])
    expect(
      getSessionHooks(testContext.getState(), getSessionId()).get('Stop'),
    ).toBeUndefined()
  })

  test('Goal impossible verdict yields failed terminal state once', async () => {
    const testContext = createStopHookContext()
    registerGoalStopHook({
      setAppState: testContext.toolUseContext.setAppState,
      sessionId: getSessionId(),
      goalId: 'goal-stop-hooks',
      condition: 'finish tests',
      appendGoalStatusAttachment: () => {},
      now: () => 2500,
      currentTokens: () => 45,
    })
    hookResponse = {
      ok: false,
      impossible: true,
      reason: 'required capability unavailable',
    }

    const result = await drainStopHooks(testContext.toolUseContext)

    expect(testContext.getState().goalStatus).toMatchObject({
      active: false,
      lastCompleted: {
        status: 'failed',
        iterations: 1,
        reason: 'required capability unavailable',
      },
    })
    expect(goalAttachments(result.events)).toEqual([
      expect.objectContaining({
        status: 'failed',
        iterations: 1,
        reason: 'required capability unavailable',
      }),
    ])
  })

  test('running background work defers Goal evaluation but still runs ordinary Stop hooks, then restores Goal hook', async () => {
    const testContext = createStopHookContext()
    registerGoalStopHook({
      setAppState: testContext.toolUseContext.setAppState,
      sessionId: getSessionId(),
      goalId: 'goal-stop-hooks',
      condition: 'finish tests',
      appendGoalStatusAttachment: () => {},
    })
    registerHookCallbacks({
      Stop: [
        {
          hooks: [
            {
              type: 'callback',
              callback: async () => ({ continue: true }),
            },
          ],
        },
      ],
    })
    testContext.setTask({
      id: 'bgoaltest',
      type: 'local_bash',
      status: 'running',
      description: 'background validation',
      startTime: 1000,
      outputFile: '/tmp/bgoaltest.output',
      outputOffset: 0,
      notified: false,
      command: 'true',
      completionStatusSentInAttachment: false,
      shellCommand: null,
      lastReportedTotalLines: 0,
      isBackgrounded: true,
    })

    const result = await drainStopHooks(testContext.toolUseContext)

    expect(hookQueries).toHaveLength(0)
    expect(result.terminal).toEqual({
      blockingErrors: [],
      preventContinuation: false,
    })
    expect(testContext.getState().goalStatus).toMatchObject({
      active: true,
      iterations: 0,
    })
    expect(goalAttachments(result.events)).toEqual([])
    expect(
      getSessionHooks(testContext.getState(), getSessionId()).get('Stop'),
    ).toEqual([
      {
        matcher: '',
        skillRoot: GOAL_HOOK_ID,
        hooks: [{ type: 'prompt', prompt: 'finish tests' }],
      },
    ])
  })

  test('does not restore a deferred Goal hook after the Goal is cleared concurrently', async () => {
    const testContext = createStopHookContext()
    registerGoalStopHook({
      setAppState: testContext.toolUseContext.setAppState,
      sessionId: getSessionId(),
      goalId: 'goal-stop-hooks',
      condition: 'finish tests',
      appendGoalStatusAttachment: () => {},
    })
    registerHookCallbacks({
      Stop: [
        {
          hooks: [
            {
              type: 'callback',
              callback: async () => {
                clearGoal(
                  testContext.toolUseContext.setAppState,
                  getSessionId(),
                )
                return { continue: true }
              },
            },
          ],
        },
      ],
    })
    testContext.setTask({
      id: 'bgoaltest',
      type: 'local_bash',
      status: 'running',
      description: 'background validation',
      startTime: 1000,
      outputFile: '/tmp/bgoaltest.output',
      outputOffset: 0,
      notified: false,
      command: 'true',
      completionStatusSentInAttachment: false,
      shellCommand: null,
      lastReportedTotalLines: 0,
      isBackgrounded: true,
    })

    await drainStopHooks(testContext.toolUseContext)

    expect(testContext.getState().goalStatus).toEqual({ active: false })
    expect(
      getSessionHooks(testContext.getState(), getSessionId()).get('Stop'),
    ).toBeUndefined()
  })
})

describe('session prompt hook identity', () => {
  test('subagent execution invokes the callback in the agent session', async () => {
    const testContext = createStopHookContext()
    const callbacks: string[] = []
    const agentId = asAgentId('agent-session')
    addSessionHook(
      testContext.toolUseContext.setAppState,
      agentId,
      'PostToolUse',
      'Bash',
      { type: 'prompt', prompt: 'agent check' },
      () => callbacks.push('agent'),
      '/agent-skill',
    )
    testContext.toolUseContext.agentId = agentId
    hookResponse = { ok: true, reason: 'verified' }

    for await (const _result of executePostToolHooks(
      'Bash',
      'tool-agent',
      { command: 'true' },
      { ok: true },
      testContext.toolUseContext,
    )) {
      // consume the complete hook batch
    }

    expect(callbacks).toEqual(['agent'])
  })

  test('identical hooks invoke their originating skill callbacks', async () => {
    const testContext = createStopHookContext()
    const callbacks: string[] = []
    const sharedHookA: PromptHook = { type: 'prompt', prompt: 'shared check' }
    const sharedHookB = sharedHookA
    addSessionHook(
      testContext.toolUseContext.setAppState,
      getSessionId(),
      'PostToolUse',
      'Bash',
      sharedHookA,
      () => callbacks.push('skill-a'),
      '/skill-a',
    )
    addSessionHook(
      testContext.toolUseContext.setAppState,
      getSessionId(),
      'PostToolUse',
      'Bash',
      sharedHookB,
      () => callbacks.push('skill-b'),
      '/skill-b',
    )
    hookResponse = { ok: true, reason: 'verified' }

    for await (const _result of executePostToolHooks(
      'Bash',
      'tool-skills',
      { command: 'true' },
      { ok: true },
      testContext.toolUseContext,
    )) {
      // consume the complete hook batch
    }

    expect(callbacks).toEqual(['skill-a', 'skill-b'])
  })

  test('source-scoped removal preserves an identical hook from another skill', () => {
    const testContext = createStopHookContext()
    const sharedHookA: PromptHook = { type: 'prompt', prompt: 'shared check' }
    const sharedHookB = sharedHookA
    addSessionHook(
      testContext.toolUseContext.setAppState,
      getSessionId(),
      'PostToolUse',
      'Bash',
      sharedHookA,
      undefined,
      '/skill-a',
    )
    addSessionHook(
      testContext.toolUseContext.setAppState,
      getSessionId(),
      'PostToolUse',
      'Bash',
      sharedHookB,
      undefined,
      '/skill-b',
    )

    removeSessionHook(
      testContext.toolUseContext.setAppState,
      getSessionId(),
      'PostToolUse',
      sharedHookA,
      '/skill-a',
      'Bash',
    )

    expect(
      getSessionHooks(
        testContext.getState(),
        getSessionId(),
        'PostToolUse',
      ).get('PostToolUse'),
    ).toEqual([
      {
        matcher: 'Bash',
        skillRoot: '/skill-b',
        hooks: [sharedHookB],
      },
    ])
  })
})

describe('execPromptHook continuation semantics', () => {
  test('settings schema accepts continueOnBlock on prompt hooks', () => {
    expect(
      HookCommandSchema().parse({
        type: 'prompt',
        prompt: 'check',
        continueOnBlock: true,
      }),
    ).toEqual({
      type: 'prompt',
      prompt: 'check',
      continueOnBlock: true,
    })
  })

  test.each(['Stop', 'SubagentStop'] as const)(
    '%s ok:false returns blocking feedback without ending the loop',
    async (hookEvent) => {
      const result = await execPromptHook(
        hook,
        hookEvent,
        hookEvent,
        '{}',
        new AbortController().signal,
        context,
      )

      expect(result.outcome).toBe('blocking')
      expect(result.blockingError?.blockingError).toContain('work remains')
      expect(result.preventContinuation).toBe(false)
      expect(result.stopReason).toBe('work remains')
    },
  )

  test('non-Stop ok:false still prevents continuation by default', async () => {
    const result = await execPromptHook(
      hook,
      'UserPromptSubmit',
      'UserPromptSubmit',
      '{}',
      new AbortController().signal,
      context,
    )

    expect(result.outcome).toBe('blocking')
    expect(result.preventContinuation).toBe(true)
    expect(result.stopReason).toBe('work remains')
  })

  test('non-Stop continueOnBlock allows continuation', async () => {
    const result = await execPromptHook(
      { ...hook, continueOnBlock: true },
      'PostToolUse',
      'PostToolUse',
      '{}',
      new AbortController().signal,
      context,
    )

    expect(result.outcome).toBe('blocking')
    expect(result.preventContinuation).toBe(false)
    expect(result.stopReason).toBe('work remains')
  })

  test('Stop impossible verdict succeeds and preserves the reason', async () => {
    hookResponse = {
      ok: false,
      impossible: true,
      reason: 'condition cannot be satisfied',
    }

    const result = await execPromptHook(
      hook,
      'Stop',
      'Stop',
      '{}',
      new AbortController().signal,
      context,
    )

    expect(result.outcome).toBe('success')
    expect(result.impossible).toBe(true)
    expect(result.stopReason).toBe('condition cannot be satisfied')
    expect(result.blockingError).toBeUndefined()
  })

  test('non-Stop impossible verdict remains a normal block', async () => {
    hookResponse = {
      ok: false,
      impossible: true,
      reason: 'condition cannot be satisfied',
    }

    const result = await execPromptHook(
      hook,
      'PostToolUse',
      'PostToolUse',
      '{}',
      new AbortController().signal,
      context,
    )

    expect(result.outcome).toBe('blocking')
    expect(result.impossible).toBeUndefined()
    expect(result.preventContinuation).toBe(true)
  })

  test('successful Stop verdict preserves evaluator evidence', async () => {
    hookResponse = { ok: true, reason: 'condition is verified' }

    const result = await execPromptHook(
      hook,
      'Stop',
      'Stop',
      '{}',
      new AbortController().signal,
      context,
    )

    expect(result.outcome).toBe('success')
    expect(result.stopReason).toBe('condition is verified')
  })

  test('evaluator has no tools and requires reason in its output schema', async () => {
    hookResponse = { ok: true, reason: 'verified' }

    await execPromptHook(
      hook,
      'Stop',
      'Stop',
      '{}',
      new AbortController().signal,
      context,
    )

    expect(hookQueries).toHaveLength(1)
    expect(hookQueries[0]?.tools).toEqual([])
    expect(hookQueries[0]?.options.outputFormat).toMatchObject({
      type: 'json_schema',
      schema: { required: ['ok', 'reason'], additionalProperties: false },
    })
  })

  test('evaluator API errors are non-blocking hook errors', async () => {
    queuedResponses.push(assistantResponse('upstream unavailable', true))

    const result = await execPromptHook(
      hook,
      'Stop',
      'Stop',
      '{}',
      new AbortController().signal,
      context,
    )

    expect(result.outcome).toBe('non_blocking_error')
    expect(result.blockingError).toBeUndefined()
    const message = result.message as unknown as AttachmentMessage | undefined
    expect(message?.type).toBe('attachment')
    expect(message?.attachment).toMatchObject({
      type: 'hook_non_blocking_error',
      stderr: 'Hook evaluator API error: upstream unavailable',
    })
  })

  test('missing evaluator reason remains a blocking verdict', async () => {
    queuedResponses.push(assistantResponse(JSON.stringify({ ok: false })))

    const result = await execPromptHook(
      hook,
      'Stop',
      'Stop',
      '{}',
      new AbortController().signal,
      context,
    )

    expect(result.outcome).toBe('blocking')
    expect(result.blockingError).toEqual({
      blockingError: '[Check this condition: $ARGUMENTS]: undefined',
      command: 'Check this condition: $ARGUMENTS',
    })
    expect(result.stopReason).toBeUndefined()
  })

  test('prompt-too-long retries with a smaller transcript window', async () => {
    queuedResponses.push(assistantResponse('Prompt is too long', true))
    hookResponse = { ok: true, reason: 'verified after retry' }

    const transcript: Message[] = []
    for (let index = 0; index < 4; index++) {
      transcript.push({
        type: 'user',
        uuid: `00000000-0000-4000-8000-00000000020${index}`,
        timestamp: '2026-08-31T00:00:00.000Z',
        message: { role: 'user', content: `round ${index}` },
      } as Message)
      transcript.push({
        type: 'assistant',
        uuid: `00000000-0000-4000-8000-00000000030${index}`,
        timestamp: '2026-08-31T00:00:00.000Z',
        message: {
          id: `msg_round_${index}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-4-5-20251001',
          content: [{ type: 'text', text: 'x'.repeat(120_000) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: 150_000,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      } as unknown as Message)
    }

    const result = await execPromptHook(
      { ...hook, model: 'claude-haiku-4-5-20251001' },
      'Stop',
      'Stop',
      '{}',
      new AbortController().signal,
      context,
      transcript,
    )

    expect(result.outcome).toBe('success')
    expect(hookQueries).toHaveLength(2)
    expect(hookQueries[1]!.messages.length).toBeLessThan(
      hookQueries[0]!.messages.length,
    )
  })

  test('prompt-too-long retry preserves an oversized final API round', async () => {
    queuedResponses.push(assistantResponse('Prompt is too long', true))
    hookResponse = { ok: true, reason: 'verified after retry' }

    const transcript = [
      {
        type: 'assistant',
        uuid: '00000000-0000-4000-8000-000000000401',
        timestamp: '2026-08-31T00:00:00.000Z',
        message: {
          id: 'msg_oversized_final_round',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-4-5-20251001',
          content: [{ type: 'text', text: 'x'.repeat(500_000) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: 150_000,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      } as unknown as Message,
    ]

    const result = await execPromptHook(
      { ...hook, model: 'claude-haiku-4-5-20251001' },
      'Stop',
      'Stop',
      '{}',
      new AbortController().signal,
      context,
      transcript,
    )

    expect(result.outcome).toBe('success')
    expect(hookQueries).toHaveLength(2)
    expect(hookQueries[1]!.messages).toHaveLength(2)
    expect(hookQueries[1]!.messages[0]).toBe(transcript[0])
    expect(
      (
        hookQueries[1]!.messages[1] as Message & {
          message: { content: string }
        }
      ).message.content,
    ).toContain('Check this condition')
  })
})
