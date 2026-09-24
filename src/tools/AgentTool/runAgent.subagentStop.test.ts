import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { SubagentStopHookInput } from '../../entrypoints/agentSdkTypes.js'

const childProcessEnv = 'CLAUDE_CODE_RUN_AGENT_SUBAGENT_STOP_TEST_CHILD'

if (process.env[childProcessEnv] === '1') {
  await runIsolatedTests()
} else {
  describe('runAgent SubagentStop fallback', () => {
    test('passes the isolated fallback suite', async () => {
      const child = Bun.spawn(
        [process.execPath, 'test', '--timeout', '30000', import.meta.path],
        {
          cwd: import.meta.dir,
          env: { ...process.env, [childProcessEnv]: '1' },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])

      if (exitCode !== 0) {
        throw new Error(
          `Isolated SubagentStop tests failed (${exitCode})\n${stdout}\n${stderr}`,
        )
      }
    })
  })
}

async function runIsolatedTests(): Promise<void> {
  type QueryMode =
    | 'throw'
    | 'assistant_then_throw'
    | 'model_error'
    | 'attachment_then_throw'
    | 'progress_then_throw'
    | 'summary_then_throw'
    | 'stream_start'
    | 'api_error'
    | 'max_turns'
    | 'complete'
  let queryMode: QueryMode = 'throw'
  const recordedMessages: unknown[] = []
  const queryContexts: Record<string, string>[] = []
  const refreshCallbacks: Array<
    (() => Promise<Record<string, string>>) | undefined
  > = []

  mock.module('../../query.js', () => ({
    query: async function* (params: import('../../query.js').QueryParams) {
      params.onCacheSafeParams?.({
        systemPrompt: params.systemPrompt,
        userContext: params.userContext,
        resolvedPromptContextBlocks: params.resolvedPromptContextBlocks,
        systemContext: params.systemContext,
        toolUseContext: params.toolUseContext,
        forkContextMessages: params.messages,
      })
      queryContexts.push(params.userContext)
      refreshCallbacks.push(params.refreshUserContext)
      if (queryMode === 'assistant_then_throw' || queryMode === 'model_error') {
        yield {
          type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000199',
          timestamp: '2026-09-01T00:00:00.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'work completed before failure' }],
          },
        }
        if (queryMode === 'model_error') return { reason: 'model_error' }
      }
      if (queryMode === 'complete') return { reason: 'completed' }
      if (queryMode === 'api_error') return { reason: 'completed' }
      if (queryMode === 'max_turns') {
        yield {
          type: 'attachment',
          uuid: '00000000-0000-4000-8000-000000000198',
          timestamp: '2026-09-01T00:00:00.000Z',
          attachment: {
            type: 'max_turns_reached',
            maxTurns: 1,
            turnCount: 2,
          },
        }
        return { reason: 'max_turns' }
      }
      if (queryMode === 'stream_start') {
        yield { type: 'stream_request_start' }
        return
      }
      if (queryMode === 'attachment_then_throw') {
        yield {
          type: 'attachment',
          uuid: '00000000-0000-4000-8000-000000000200',
          timestamp: '2026-09-01T00:00:00.000Z',
          attachment: {
            type: 'hook_success',
            content: '',
            hookName: 'SubagentStop',
            toolUseID: 'hook-subagent-stop',
            hookEvent: 'SubagentStop',
          },
        }
      }
      if (queryMode === 'progress_then_throw') {
        yield {
          type: 'progress',
          uuid: '00000000-0000-4000-8000-000000000201',
          timestamp: '2026-09-01T00:00:00.000Z',
          toolUseID: 'hook-subagent-stop',
          parentToolUseID: '',
          data: {
            type: 'hook_progress',
            hookEvent: 'SubagentStop',
            hookName: 'SubagentStop',
            command: 'test hook',
          },
        }
      }
      if (queryMode === 'summary_then_throw') {
        yield {
          type: 'system',
          subtype: 'stop_hook_summary',
          uuid: '00000000-0000-4000-8000-000000000202',
          timestamp: '2026-09-01T00:00:00.000Z',
          hookCount: 1,
          hookInfos: [],
          hookErrors: [],
          preventedContinuation: false,
          hasOutput: false,
          level: 'suggestion',
        }
      }
      throw new Error('query failed before SubagentStop')
    },
  }))

  const sessionStorage = await import('../../utils/sessionStorage.js')
  mock.module('../../utils/sessionStorage.js', () => ({
    ...sessionStorage,
    recordSidechainTranscript: async (messages: unknown[]) => {
      recordedMessages.push(...messages)
    },
    writeAgentMetadata: async () => {},
    setAgentTranscriptSubdir: () => {},
    clearAgentTranscriptSubdir: () => {},
  }))

  const { registerHookCallbacks, resetStateForTests } =
    await import('../../bootstrap/state.js')
  const { addFunctionHook } = await import('../../utils/hooks/sessionHooks.js')
  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  const { createFileStateCacheWithSizeLimit } =
    await import('../../utils/fileStateCache.js')
  const { createUserMessage } = await import('../../utils/messages.js')
  const { asSystemPrompt } = await import('../../utils/systemPromptType.js')
  const { createAgentId } = await import('../../utils/uuid.js')
  const { GENERAL_PURPOSE_AGENT } =
    await import('./built-in/generalPurposeAgent.js')
  const { runAgent } = await import('./runAgent.js')
  const testAgentId = createAgentId('agent-subagent-stop-test')

  function createContext(permissionMode = 'default' as const) {
    let appState = getDefaultAppState()
    appState = {
      ...appState,
      toolPermissionContext: {
        ...appState.toolPermissionContext,
        mode: permissionMode,
      },
    }
    return {
      options: {
        commands: [],
        debug: false,
        mainLoopModel: 'claude-sonnet-4-6' as const,
        tools: [],
        verbose: false,
        thinkingConfig: { type: 'disabled' as const },
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
      setAppState: (updater: (state: typeof appState) => typeof appState) => {
        appState = updater(appState)
      },
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: () => {},
      updateAttributionState: () => {},
      messages: [],
    }
  }

  async function drainAgent(extra: Partial<Parameters<typeof runAgent>[0]> = {}): Promise<void> {
    const iterator = runAgent({
      agentDefinition: GENERAL_PURPOSE_AGENT,
      promptMessages: [createUserMessage({ content: 'finish the task' })],
      toolUseContext: createContext(),
      canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      isAsync: false,
      querySource: 'agent:test',
      availableTools: [],
      override: {
        agentId: testAgentId,
        userContext: {},
        systemContext: {},
        systemPrompt: asSystemPrompt([]),
      },
      ...extra,
    })

    let next = await iterator.next()
    while (!next.done) {
      next = await iterator.next()
    }
  }

  beforeEach(() => {
    resetStateForTests()
    queryMode = 'throw'
    recordedMessages.length = 0
    queryContexts.length = 0
    refreshCallbacks.length = 0
    delete process.env.CLAUDE_CODE_RUN_AGENT_FAULT_INJECTION_FOR_TESTING
  })

  test('query refresh reloads agent context while keeping explicit overrides and read-only omissions', async () => {
    queryMode = 'complete'
    const contextModule = await import('../../context.js')
    const { EXPLORE_AGENT } = await import('./built-in/exploreAgent.js')
    const { PLAN_AGENT } = await import('./built-in/planAgent.js')
    const files = [
      {
        path: '/fixture/CLAUDE.md',
        kind: 'project' as const,
        content: 'original',
      },
    ]
    const freshFiles = [{ ...files[0]!, content: 'fresh' }]
    const original = contextModule.withUserContextInstructionFiles(
      { claudeMd: 'original', currentDate: 'today' },
      files,
    )
    const fresh = contextModule.withUserContextInstructionFiles(
      { claudeMd: 'fresh', currentDate: 'tomorrow', extra: 'new' },
      freshFiles,
    )
    const load = spyOn(contextModule, 'getUserContext').mockResolvedValue(original)
    const override = {
      agentId: testAgentId,
      systemContext: {},
      systemPrompt: asSystemPrompt([]),
    }
    try {
      for (const agentDefinition of [
        GENERAL_PURPOSE_AGENT,
        EXPLORE_AGENT,
        PLAN_AGENT,
      ]) {
        load.mockResolvedValue(original)
        await drainAgent({ override, agentDefinition })
        const refresh = refreshCallbacks.at(-1)
        expect(refresh).toBeFunction()
        load.mockResolvedValue(fresh)
        const refreshed = await refresh!()
        if (agentDefinition.omitClaudeMd) {
          expect(queryContexts.at(-1)).toEqual({ currentDate: 'today' })
          expect(refreshed).toEqual({ currentDate: 'tomorrow', extra: 'new' })
          expect(
            contextModule.getUserContextInstructionFiles(refreshed),
          ).toEqual([])
        } else {
          expect(queryContexts.at(-1)).toBe(original)
          expect(refreshed).toBe(fresh)
          expect(
            contextModule.getUserContextInstructionFiles(refreshed),
          ).toEqual(freshFiles)
        }
        load.mockResolvedValue(
          contextModule.withUserContextInstructionFiles(
            { currentDate: 'after removal' },
            [],
          ),
        )
        const removed = await refresh!()
        expect(removed).toEqual({ currentDate: 'after removal' })
        expect(contextModule.getUserContextInstructionFiles(removed)).toEqual([])
      }
      expect(load).toHaveBeenCalledTimes(9)
      for (const userContext of [original, { claudeMd: 'opaque override' }, {}]) {
        await drainAgent({
          override: { ...override, userContext },
          agentDefinition: EXPLORE_AGENT,
        })
        const refresh = refreshCallbacks.at(-1)
        expect(refresh).toBeFunction()
        expect(await refresh!()).toBe(userContext)
        expect(
          contextModule.getUserContextInstructionFiles(await refresh!()),
        ).toEqual(
          userContext === original
            ? files
            : 'claudeMd' in userContext
              ? undefined
              : [],
        )
      }
      expect(load).toHaveBeenCalledTimes(9)
    } finally {
      load.mockRestore()
    }
  })

  test('resolved model bypasses later env and definition changes', async () => {
    queryMode = 'complete'
    const previous = process.env.CLAUDE_CODE_SUBAGENT_MODEL
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'env-changed-after-spawn'
    let observedModel: string | undefined
    try {
      await drainAgent({
        resolvedModel: 'Snapshot/Custom-ID',
        model: 'tool-model',
        agentDefinition: { ...GENERAL_PURPOSE_AGENT, model: 'definition-model' },
        onCacheSafeParams: params => { observedModel = params.toolUseContext.options.mainLoopModel },
      })
      expect(observedModel).toBe('Snapshot/Custom-ID')
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
      else process.env.CLAUDE_CODE_SUBAGENT_MODEL = previous
    }
  })

  for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-6', 'custom-opus-5-gateway']) {
    test(`${model} uses the appropriate parent or legacy thinking default`, async () => {
      queryMode = 'complete'
      const context = createContext()
      const thinkingConfig = { type: 'enabled' as const, budgetTokens: 2048 }
      let observedThinking: unknown
      await drainAgent({
        resolvedModel: model,
        toolUseContext: { ...context, options: { ...context.options, thinkingConfig } },
        onCacheSafeParams: params => { observedThinking = params.toolUseContext.options.thinkingConfig },
      })
      expect(observedThinking).toEqual(
        model === 'claude-opus-5' || model === 'claude-sonnet-5' ? thinkingConfig : { type: 'disabled' },
      )
    })
  }

  test('Opus 5 preserves explicitly disabled parent thinking', async () => {
    queryMode = 'complete'
    let observedThinking: unknown
    await drainAgent({
      resolvedModel: 'claude-opus-5',
      onCacheSafeParams: params => { observedThinking = params.toolUseContext.options.thinkingConfig },
    })
    expect(observedThinking).toEqual({ type: 'disabled' })
  })

  test('runs SubagentStop once for the controlled post-start fault', async () => {
    const observedInputs: SubagentStopHookInput[] = []
    queryMode = 'stream_start'
    process.env.CLAUDE_CODE_RUN_AGENT_FAULT_INJECTION_FOR_TESTING =
      'after_query_start'
    registerHookCallbacks({
      SubagentStop: [
        {
          hooks: [
            {
              type: 'callback',
              callback: async (input) => {
                observedInputs.push(input as SubagentStopHookInput)
                return { continue: true }
              },
            },
          ],
        },
      ],
    })

    await expect(drainAgent()).rejects.toThrow(
      'RELEASE_SUBAGENT_QUERY_FAILURE',
    )
    expect(observedInputs).toHaveLength(1)
    expect(observedInputs[0]).toMatchObject({
      hook_event_name: 'SubagentStop',
      stop_hook_active: false,
      agent_id: testAgentId,
      agent_type: 'general-purpose',
    })
  })

  test('runs SubagentStop once when query throws before the hook boundary', async () => {
    const observedInputs: SubagentStopHookInput[] = []
    registerHookCallbacks({
      SubagentStop: [
        {
          hooks: [
            {
              type: 'callback',
              callback: async (input) => {
                observedInputs.push(input as SubagentStopHookInput)
                return { continue: true }
              },
            },
          ],
        },
      ],
    })

    await expect(drainAgent()).rejects.toThrow(
      'query failed before SubagentStop',
    )
    expect(observedInputs).toHaveLength(1)
    expect(observedInputs[0]).toMatchObject({
      hook_event_name: 'SubagentStop',
      stop_hook_active: false,
      agent_id: testAgentId,
      agent_type: 'general-purpose',
      permission_mode: 'default',
    })
  })

  test('runs SubagentStop when query returns a model error before the hook boundary', async () => {
    let hookCalls = 0
    queryMode = 'model_error'
    registerHookCallbacks({
      SubagentStop: [
        {
          hooks: [
            {
              type: 'callback',
              callback: async () => {
                hookCalls++
                return { continue: true }
              },
            },
          ],
        },
      ],
    })

    await drainAgent()
    expect(hookCalls).toBe(1)
  })

  test('does not duplicate SubagentStop after its result attachment boundary', async () => {
    let hookCalls = 0
    queryMode = 'attachment_then_throw'
    registerHookCallbacks({
      SubagentStop: [
        {
          hooks: [
            {
              type: 'callback',
              callback: async () => {
                hookCalls++
                return { continue: true }
              },
            },
          ],
        },
      ],
    })

    await expect(drainAgent()).rejects.toThrow(
      'query failed before SubagentStop',
    )
    expect(hookCalls).toBe(0)
  })

  test('does not duplicate SubagentStop after its progress boundary', async () => {
    let hookCalls = 0
    queryMode = 'progress_then_throw'
    registerHookCallbacks({
      SubagentStop: [
        {
          hooks: [
            {
              type: 'callback',
              callback: async () => {
                hookCalls++
                return { continue: true }
              },
            },
          ],
        },
      ],
    })

    await expect(drainAgent()).rejects.toThrow(
      'query failed before SubagentStop',
    )
    expect(hookCalls).toBe(0)
  })

  test('runs the fallback when only a summary is observed', async () => {
    let hookCalls = 0
    queryMode = 'summary_then_throw'
    registerHookCallbacks({
      SubagentStop: [
        {
          hooks: [
            {
              type: 'callback',
              callback: async () => {
                hookCalls++
                return { continue: true }
              },
            },
          ],
        },
      ],
    })

    await expect(drainAgent()).rejects.toThrow(
      'query failed before SubagentStop',
    )
    expect(hookCalls).toBe(1)
  })

  test('provides the full subagent conversation to fallback function hooks', async () => {
    const observedMessages: string[] = []
    const toolUseContext = createContext()
    queryMode = 'assistant_then_throw'
    addFunctionHook(
      toolUseContext.setAppState,
      testAgentId,
      'SubagentStop',
      '',
      messages => {
        observedMessages.push(
          messages
            .filter(
              message =>
                message.type === 'user' || message.type === 'assistant',
            )
            .map(message =>
              typeof message.message.content === 'string'
                ? message.message.content
                : message.message.content
                    .filter(block => block.type === 'text')
                    .map(block => block.text)
                    .join(''),
            )
            .join('\n'),
        )
        return true
      },
      'fallback failed',
    )

    const iterator = runAgent({
      agentDefinition: GENERAL_PURPOSE_AGENT,
      promptMessages: [createUserMessage({ content: 'finish the task' })],
      toolUseContext,
      canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      isAsync: false,
      querySource: 'agent:test',
      availableTools: [],
      override: {
        agentId: testAgentId,
        userContext: {},
        systemContext: {},
        systemPrompt: asSystemPrompt([]),
      },
    })

    let thrown: unknown
    try {
      let next = await iterator.next()
      while (!next.done) next = await iterator.next()
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe(
      'query failed before SubagentStop',
    )
    expect(observedMessages).toEqual([
      'finish the task\nwork completed before failure',
    ])
  })

  test('records fallback blocking feedback', async () => {
    const toolUseContext = createContext()
    addFunctionHook(
      toolUseContext.setAppState,
      testAgentId,
      'SubagentStop',
      '',
      () => false,
      'fallback failed',
    )

    await expect(
      runAgent({
        agentDefinition: GENERAL_PURPOSE_AGENT,
        promptMessages: [createUserMessage({ content: 'finish the task' })],
        toolUseContext,
        canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
        isAsync: false,
        querySource: 'agent:test',
        availableTools: [],
        override: {
          agentId: testAgentId,
          userContext: {},
          systemContext: {},
          systemPrompt: asSystemPrompt([]),
        },
      }).next(),
    ).rejects.toThrow('query failed before SubagentStop')
    expect(
      recordedMessages.some(
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === 'user' &&
          'message' in message &&
          JSON.stringify(message.message).includes(
            'Stop hook feedback:\\nfallback failed',
          ),
      ),
    ).toBe(true)
  })

  test.each(['complete', 'api_error', 'max_turns'] as const)(
    'does not run the fallback after %s terminal completion',
    async terminalMode => {
      let hookCalls = 0
      queryMode = terminalMode
      registerHookCallbacks({
        SubagentStop: [
          {
            hooks: [
              {
                type: 'callback',
                callback: async () => {
                  hookCalls++
                  return { continue: true }
                },
              },
            ],
          },
        ],
      })

      await drainAgent()
      expect(hookCalls).toBe(0)
    },
  )
}
