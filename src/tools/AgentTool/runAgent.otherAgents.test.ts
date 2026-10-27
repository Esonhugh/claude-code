import { describe, expect, mock, test } from 'bun:test'
import type { Message } from '../../types/message.js'

// query() is mocked module-wide, so the assertions run in an isolated child.
const childFlag = 'CLAUDE_CODE_RUN_AGENT_OTHER_AGENTS_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  describe('runAgent other-agents reminder', () => {
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
  let seen: Message[] = []
  mock.module('../../query.js', () => ({
    // eslint-disable-next-line require-yield
    query: async function* (params: import('../../query.js').QueryParams) {
      seen = [...params.messages]
      return { reason: 'completed' }
    },
  }))
  const sessionStorage = await import('../../utils/sessionStorage.js')
  mock.module('../../utils/sessionStorage.js', () => ({
    ...sessionStorage,
    recordSidechainTranscript: async () => {},
    writeAgentMetadata: async () => {},
    setAgentTranscriptSubdir: () => {},
    clearAgentTranscriptSubdir: () => {},
  }))

  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  const { createFileStateCacheWithSizeLimit } = await import('../../utils/fileStateCache.js')
  const { createUserMessage } = await import('../../utils/messages.js')
  const { asSystemPrompt } = await import('../../utils/systemPromptType.js')
  const { createAgentId } = await import('../../utils/uuid.js')
  const { GENERAL_PURPOSE_AGENT } = await import('./built-in/generalPurposeAgent.js')
  const { SendMessageTool } = await import('../SendMessageTool/SendMessageTool.js')
  const { runAgent } = await import('./runAgent.js')

  async function reminders(names: string[], tools: unknown[], resumed = false): Promise<string[]> {
    const agentId = createAgentId('other-agents-test')
    let appState = getDefaultAppState()
    appState = {
      ...appState,
      agentNameRegistry: new Map([...names.map(name => [name, createAgentId(name)] as const), ['self', agentId] as const]) as never,
    }
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
    }
    for await (const _ of runAgent({
      agentDefinition: GENERAL_PURPOSE_AGENT,
      promptMessages: [createUserMessage({ content: 'do the task' })],
      toolUseContext: context as never,
      canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      isAsync: true,
      querySource: 'agent:test' as never,
      availableTools: tools as never,
      override: { agentId, userContext: {}, systemContext: {}, systemPrompt: asSystemPrompt([]) },
      ...(resumed && { contentReplacementState: { seenIds: new Set(), replacements: new Map() } as never }),
    })) { /* drain */ }
    return seen.flatMap(m => m.type === 'user' && m.isMeta && typeof m.message.content === 'string' && m.message.content.includes('Other agents active') ? [m.message.content] : [])
  }

  test('a new agent with SendMessage learns the other named agents, like official 2.1.311', async () => {
    expect(await reminders(['zeta', 'alpha'], [SendMessageTool])).toEqual([
      '<system-reminder>\nOther agents active in this session, addressable via SendMessage({to: name, message}): main, alpha, zeta.\n</system-reminder>',
    ])
  })

  test('no reminder without other agents, without SendMessage, or on resume', async () => {
    expect(await reminders([], [SendMessageTool])).toEqual([])
    expect(await reminders(['alpha'], [])).toEqual([])
    expect(await reminders(['alpha'], [SendMessageTool], true)).toEqual([])
  })
}
