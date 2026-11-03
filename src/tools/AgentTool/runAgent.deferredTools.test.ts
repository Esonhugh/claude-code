import { describe, expect, mock, test } from 'bun:test'
import type { Message } from '../../types/message.js'

// query() is mocked module-wide, so the assertions run in an isolated child.
const childFlag = 'CLAUDE_CODE_RUN_AGENT_DEFERRED_TOOLS_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  describe('runAgent deferred tools announcement', () => {
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
  const toolSearch = await import('../../utils/toolSearch.js')
  mock.module('../../utils/toolSearch.js', () => ({
    ...toolSearch,
    isDeferredToolsDeltaEnabled: () => true,
    isToolSearchEnabledOptimistic: () => true,
    modelSupportsToolReference: () => true,
  }))

  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  const { createFileStateCacheWithSizeLimit } = await import('../../utils/fileStateCache.js')
  const { createUserMessage } = await import('../../utils/messages.js')
  const { asSystemPrompt } = await import('../../utils/systemPromptType.js')
  const { createAgentId } = await import('../../utils/uuid.js')
  const { GENERAL_PURPOSE_AGENT } = await import('./built-in/generalPurposeAgent.js')
  const { ToolSearchTool } = await import('../ToolSearchTool/ToolSearchTool.js')
  const { WebFetchTool } = await import('../WebFetchTool/WebFetchTool.js')
  const { runAgent } = await import('./runAgent.js')

  async function announced(resumed: boolean): Promise<string[]> {
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
    }
    for await (const _ of runAgent({
      agentDefinition: GENERAL_PURPOSE_AGENT,
      promptMessages: [createUserMessage({ content: 'do the task' })],
      toolUseContext: context as never,
      canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      isAsync: true,
      querySource: 'agent:test' as never,
      availableTools: [ToolSearchTool, WebFetchTool] as never,
      override: { agentId: createAgentId('deferred-test'), userContext: {}, systemContext: {}, systemPrompt: asSystemPrompt([]) },
      ...(resumed && { contentReplacementState: { seenIds: new Set(), replacements: new Map() } as never }),
    })) { /* drain */ }
    return seen.flatMap(m => (m.type === 'attachment' && m.attachment.type === 'deferred_tools_delta' ? m.attachment.addedNames : []))
  }

  // Official 2.1.x lists a worker's deferred tools in its first request.
  test('a new agent learns its deferred tools before its first request', async () => {
    expect(await announced(false)).toEqual(['WebFetch'])
  })

  test('a resumed agent already has them in its history', async () => {
    expect(await announced(true)).toEqual([])
  })
}
