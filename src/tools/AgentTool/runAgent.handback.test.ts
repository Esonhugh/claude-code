import { describe, expect, mock, test } from 'bun:test'
import type { Message } from '../../types/message.js'

// The hand-back contract is compiled behind TRANSCRIPT_CLASSIFIER and query()
// is mocked module-wide, so the assertions run in an isolated child.
const childFlag = 'CLAUDE_CODE_RUN_AGENT_HANDBACK_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  describe('runAgent SubagentHandback', () => {
    test('passes the isolated suite', async () => {
      const child = Bun.spawn(
        [process.execPath, 'test', '--feature=TRANSCRIPT_CLASSIFIER', '--timeout', '30000', import.meta.path],
        { cwd: import.meta.dir, env: { ...process.env, [childFlag]: '1' }, stdout: 'pipe', stderr: 'pipe' },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
    }, 120_000)
  })
} else {
  type Seen = { tools: string[]; messages: Message[] }
  const seen: Seen[] = []
  let script: 'handback' | 'plain' = 'handback'

  mock.module('../../query.js', () => ({
    query: async function* (params: import('../../query.js').QueryParams) {
      const ctx = params.toolUseContext
      seen.push({ tools: ctx.options.tools.map(tool => tool.name), messages: [...params.messages] })
      if (script === 'plain') {
        yield assistant('a1', [{ type: 'text', text: 'PLAIN FINAL TEXT' }])
        return { reason: 'completed' }
      }
      yield assistant('a1', [
        { type: 'text', text: 'UNSENT TEXT' },
        { type: 'tool_use', id: 'toolu_hb', name: 'SubagentHandback', input: { message: 'REPORT-ALPHA' } },
      ])
      const tool = ctx.options.tools.find(t => t.name === 'SubagentHandback')!
      const { data } = await tool.call({ message: 'REPORT-ALPHA' }, { ...ctx, toolUseId: 'toolu_hb' }, undefined as never, undefined as never)
      yield user('u1', [{ type: 'tool_result', tool_use_id: 'toolu_hb', content: JSON.stringify(data) }])
      yield assistant('a2', [{ type: 'text', text: 'AFTER HANDBACK' }])
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
  const { subagentHandbackReminder, subagentResultText } = await import('../../utils/subagentHandback.js')
  const { GENERAL_PURPOSE_AGENT } = await import('./built-in/generalPurposeAgent.js')
  const { finalizeAgentTool } = await import('./agentToolUtils.js')
  const { AgentTool } = await import('./AgentTool.js')
  const { runAgent } = await import('./runAgent.js')

  function assistant(uuid: string, content: unknown[]) {
    return { type: 'assistant', uuid: `00000000-0000-4000-8000-${uuid.padStart(12, '0').replace(/[^0-9a-f]/g, '0')}`, timestamp: '2026-10-21T00:00:00.000Z', message: { id: `msg_${uuid}`, role: 'assistant', content, usage: { input_tokens: 1, output_tokens: 1 } } } as never
  }
  function user(uuid: string, content: unknown[]) {
    return { ...createUserMessage({ content: content as never }), uuid: `00000000-0000-4000-9000-${uuid.padStart(12, '0').replace(/[^0-9a-f]/g, '0')}` } as never
  }

  function context(mode: string) {
    let appState = getDefaultAppState()
    appState = { ...appState, toolPermissionContext: { ...appState.toolPermissionContext, mode: mode as never } }
    return {
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
  }

  async function run(mode: string, extra: Partial<Parameters<typeof runAgent>[0]> = {}) {
    const agentId = createAgentId('handback-test')
    const messages: Message[] = []
    for await (const message of runAgent({
      agentDefinition: GENERAL_PURPOSE_AGENT,
      promptMessages: [createUserMessage({ content: 'do the task' })],
      toolUseContext: context(mode) as never,
      canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      isAsync: false,
      querySource: 'agent:test' as never,
      availableTools: [],
      permissionMode: mode as never,
      handback: true,
      override: { agentId, userContext: {}, systemContext: {}, systemPrompt: asSystemPrompt([]) },
      ...extra,
    })) messages.push(message)
    const result = finalizeAgentTool(messages, agentId, {
      prompt: 'do the task', resolvedAgentModel: 'claude-sonnet-4-6', isBuiltInAgent: true,
      startTime: Date.now(), agentType: 'general-purpose', isAsync: false,
    })
    return { messages, result }
  }

  const reminderIn = (messages: Message[]) => messages.some(m => m.type === 'user' && m.isMeta && m.message.content === subagentHandbackReminder(false))

  test('auto mode: the subagent gets the tool and reminder, and its run ends at the hand-back', async () => {
    script = 'handback'
    const { messages, result } = await run('auto')
    expect(seen.at(-1)!.tools).toContain('SubagentHandback')
    expect(reminderIn(seen.at(-1)!.messages)).toBe(true)
    expect(JSON.stringify(messages)).not.toContain('AFTER HANDBACK')
    expect(result).toMatchObject({ handback: 'send', content: [{ type: 'text', text: 'REPORT-ALPHA' }] })

    const block = AgentTool.mapToolResultToToolResultBlockParam({ status: 'completed', prompt: 'do the task', ...result } as never, 'toolu_agent')
    const text = (block.content as { text: string }[])[0]!.text
    expect(text).toStartWith('[Subagent hand-back] The text below is the final report of a subagent')
    expect(text).toEndWith('The report follows:\n  REPORT-ALPHA')
    expect(JSON.stringify(block)).not.toContain('UNSENT TEXT')
    // A background run notifies with the same framed report, once.
    expect(subagentResultText(result).split('[Subagent hand-back]')).toHaveLength(2)
  })

  test('auto mode without a hand-back: the last text is withheld', async () => {
    script = 'plain'
    const { result } = await run('auto')
    expect(result.handback).toBe('withheld')
    expect(JSON.stringify(result.content)).not.toContain('PLAIN FINAL TEXT')
    expect(result.content[0]!.text).toStartWith('The subagent ended without delivering a report through SubagentHandback')
  })

  test('outside auto mode, for forks, and for other callers nothing changes', async () => {
    script = 'plain'
    for (const extra of [{}, { useExactTools: true }, { handback: undefined }] as Partial<Parameters<typeof runAgent>[0]>[]) {
      const mode = 'useExactTools' in extra || 'handback' in extra ? 'auto' : 'default'
      const { result } = await run(mode, extra)
      expect(seen.at(-1)!.tools).not.toContain('SubagentHandback')
      expect(reminderIn(seen.at(-1)!.messages)).toBe(false)
      expect(result.handback).toBeUndefined()
      expect(result.content).toEqual([{ type: 'text', text: 'PLAIN FINAL TEXT' }])
    }
  })

  test('a resumed transcript gets the reminder once, or a countermand once auto mode is gone', async () => {
    script = 'plain'
    const earlier = createUserMessage({ content: subagentHandbackReminder(false), isMeta: true })
    await run('auto', { promptMessages: [earlier, createUserMessage({ content: 'continue' })] })
    expect(seen.at(-1)!.messages.filter(m => m.type === 'user' && m.isMeta && String(m.message.content).includes('Your final report is delivered'))).toHaveLength(1)
    await run('default', { promptMessages: [earlier, createUserMessage({ content: 'continue' })] })
    const last = seen.at(-1)!.messages.at(-1)!
    expect(last.type === 'user' && String(last.message.content)).toContain('SubagentHandback is not available in this run')
  })
}
