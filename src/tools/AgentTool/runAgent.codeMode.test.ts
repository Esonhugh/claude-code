import { describe, expect, mock, test } from 'bun:test'

// query() and the REPL sessions are mocked module-wide, so the assertions run in an isolated child.
const childFlag = 'CLAUDE_CODE_RUN_AGENT_CODE_MODE_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  describe('runAgent in Code Mode', () => {
    test('passes the isolated suite', async () => {
      const child = Bun.spawn(
        [process.execPath, 'test', '--timeout', '30000', import.meta.path],
        { cwd: import.meta.dir, env: { ...process.env, [childFlag]: '1' }, stdout: 'pipe', stderr: 'pipe' },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
    }, 120_000)
  })
} else {
  let queryMode: 'complete' | 'throw' = 'complete'
  let seenGrant: ReadonlySet<string> | undefined
  mock.module('../../query.js', () => ({
    // eslint-disable-next-line require-yield
    query: async function* (params: import('../../query.js').QueryParams) {
      seenGrant = params.toolUseContext.primitiveToolGrant
      if (queryMode === 'throw') throw new Error('model failed')
      return { reason: 'completed' }
    },
  }))
  const released: string[] = []
  const sessions = await import('../REPLTool/sessions.js')
  mock.module('../REPLTool/sessions.js', () => ({
    ...sessions,
    releaseReplSession: (key: string) => { released.push(key) },
  }))
  const sessionStorage = await import('../../utils/sessionStorage.js')
  mock.module('../../utils/sessionStorage.js', () => ({
    ...sessionStorage,
    recordSidechainTranscript: async () => {},
    writeAgentMetadata: async () => {},
    setAgentTranscriptSubdir: () => {},
    clearAgentTranscriptSubdir: () => {},
  }))

  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test', ISSUES_EXPLAINER: 'report an issue' }
  process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = '1'
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
  delete process.env.USER_TYPE
  const { setIsInteractive } = await import('../../bootstrap/state.js')
  setIsInteractive(true)
  const { settleCodeModeGate } = await import('../REPLTool/codeModeGate.js')
  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  const { createFileStateCacheWithSizeLimit } = await import('../../utils/fileStateCache.js')
  const { createUserMessage } = await import('../../utils/messages.js')
  const { asSystemPrompt } = await import('../../utils/systemPromptType.js')
  const { createAgentId } = await import('../../utils/uuid.js')
  const { GENERAL_PURPOSE_AGENT } = await import('./built-in/generalPurposeAgent.js')
  const { runAgent } = await import('./runAgent.js')

  const parentGrant: ReadonlySet<string> = new Set(['Read'])
  async function run(options: { tools?: string[]; fork?: boolean }): Promise<string> {
    const agentId = createAgentId('code-mode-test')
    let appState = getDefaultAppState()
    const context = {
      options: {
        commands: [], debug: false, mainLoopModel: 'claude-sonnet-4-6', tools: [], verbose: false,
        thinkingConfig: { type: 'disabled' as const }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: false,
        agentDefinitions: { activeAgents: [], allAgents: [], allowedAgentTypes: undefined },
      },
      abortController: new AbortController(),
      readFileState: createFileStateCacheWithSizeLimit(10),
      getAppState: () => appState,
      setAppState: (updater: (state: typeof appState) => typeof appState) => { appState = updater(appState) },
      setInProgressToolUseIDs: () => {}, setResponseLength: () => {}, updateFileHistoryState: () => {}, updateAttributionState: () => {},
      messages: [],
      primitiveToolGrant: parentGrant,
    }
    seenGrant = undefined
    const stream = runAgent({
      agentDefinition: { ...GENERAL_PURPOSE_AGENT, tools: options.tools },
      promptMessages: [createUserMessage({ content: 'do the task' })],
      toolUseContext: context as never,
      canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      isAsync: true,
      querySource: 'agent:test' as never,
      availableTools: [],
      ...(options.fork && { useExactTools: true, forkContextMessages: [] }),
      override: { agentId, userContext: {}, systemContext: {}, systemPrompt: asSystemPrompt([]) },
    })
    try {
      for await (const _ of stream) { /* drain */ }
    } catch {
      // A failed run still tears down; the caller checks the release.
    }
    return agentId
  }

  test('the gate is on for this suite', () => {
    expect(settleCodeModeGate({ remoteControl: false, remote: false }).enabled).toBe(true)
  })

  test('an agent gets the primitives its own tools list names', async () => {
    await run({ tools: ['Bash', 'Glob'] })
    expect([...seenGrant!].sort()).toEqual(['Bash', 'Glob'])
  })

  test('a fork keeps the parent grant', async () => {
    await run({ tools: ['Bash'], fork: true })
    expect(seenGrant).toBe(parentGrant)
  })

  test('the REPL context is released when the agent ends, also after an error', async () => {
    released.length = 0
    queryMode = 'complete'
    const done = await run({})
    queryMode = 'throw'
    const failed = await run({})
    queryMode = 'complete'
    expect(released).toEqual([done, failed])
  })
}
