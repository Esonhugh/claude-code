import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { getIsInteractive, setIsInteractive } from './bootstrap/state.js'
import type { QuerySource } from './constants/querySource.js'
import { query } from './query.js'
import { getDefaultAppState, type AppState } from './state/AppStateStore.js'
import { buildTool, type ToolUseContext } from './Tool.js'
import { formatPollDelivery } from './tools/PollTool/delivery.js'
import { resetToolsUsedForTesting } from './tools/PollTool/toolsUsed.js'
import { noteReplLaunchPermissionMode, resetCodeModeGateForTesting } from './tools/REPLTool/codeModeGate.js'
import {
  dispatchReplEval,
  getReplSession,
  MAIN_REPL_SESSION,
  releaseAllReplSessions,
  startReplEval,
} from './tools/REPLTool/sessions.js'
import type { AgentId } from './types/ids.js'
import type { Message } from './types/message.js'
import { createFileStateCacheWithSizeLimit } from './utils/fileStateCache.js'
import { enqueue, enqueuePollEvent, getCommandQueueSnapshot, resetCommandQueue } from './utils/messageQueueManager.js'
import { createAssistantMessage, createUserMessage, normalizeMessagesForAPI } from './utils/messages.js'
import {
  getSessionSettingsCache,
  resetSettingsCache,
  setCachedSettingsForSource,
  setSessionSettingsCache,
} from './utils/settings/settingsCache.js'
import { asSystemPrompt } from './utils/systemPromptType.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test', ISSUES_EXPLAINER: 'report an issue' }

const savedCodeMode = process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE
const savedEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
const savedInteractive = getIsInteractive()
const originalSettings = getSessionSettingsCache()
const restore = (key: string, value: string | undefined) => {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

beforeAll(() => {
  setSessionSettingsCache({ settings: {}, errors: [] })
  for (const source of ['userSettings', 'projectSettings', 'localSettings', 'policySettings', 'flagSettings'] as const)
    setCachedSettingsForSource(source, {})
  process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = '1'
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
  setIsInteractive(true)
  resetCodeModeGateForTesting()
  noteReplLaunchPermissionMode('bypassPermissions')
  resetToolsUsedForTesting()
})
afterAll(() => {
  restore('CLAUDE_CODE_EXPERIMENTAL_CODE_MODE', savedCodeMode)
  restore('CLAUDE_CODE_ENTRYPOINT', savedEntrypoint)
  setIsInteractive(savedInteractive)
  resetCodeModeGateForTesting()
  resetSettingsCache()
  if (originalSettings) setSessionSettingsCache(originalSettings)
})
afterEach(() => {
  releaseAllReplSessions()
  resetCommandQueue()
  resetToolsUsedForTesting()
})

const element = (n: number) => `<event kind="repl-eval" at="2026-11-16T00:00:00.000Z" eval="${n}" ms="1" status="settled">\n<result>${n}</result>\n</event>`

/** A tool whose call queues an eval's outcome, as a finished background eval would. */
const settleTool = buildTool({
  name: 'Settle',
  inputSchema: z.object({}),
  maxResultSizeChars: Infinity,
  isConcurrencySafe: () => true,
  description: async () => 'Settle',
  prompt: async () => 'Settle',
  renderToolUseMessage: () => null,
  call: async () => {
    void enqueuePollEvent({ kind: 'repl-eval', element: element(2) })
    return { data: 'dispatched' }
  },
  mapToolResultToToolResultBlockParam: (data: unknown, id: string) => ({ type: 'tool_result', tool_use_id: id, content: String(data) }),
})

function createToolUseContext(agentId?: AgentId): ToolUseContext {
  let appState: AppState = getDefaultAppState()
  return {
    ...(agentId !== undefined && { agentId }),
    options: {
      commands: [], debug: false, mainLoopModel: 'claude-sonnet-4-6', tools: [settleTool],
      verbose: false, thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: [], allAgents: [], allowedAgentTypes: undefined },
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(10),
    getAppState: () => appState,
    setAppState: updater => { appState = updater(appState) },
    setInProgressToolUseIDs: () => {}, setResponseLength: () => {},
    updateFileHistoryState: () => {}, updateAttributionState: () => {},
    messages: [],
  }
}

async function run(messages: Message[], { settle = false, agentId }: { settle?: boolean; agentId?: AgentId } = {}) {
  const modelRequests: Message[][] = []
  const iterator = query({
    messages,
    systemPrompt: asSystemPrompt([]), userContext: {}, systemContext: {},
    canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
    toolUseContext: createToolUseContext(agentId),
    querySource: (agentId === undefined ? 'repl_main_thread' : 'agent:custom') as QuerySource,
    deps: {
      uuid: () => crypto.randomUUID(),
      microcompact: async messages => ({ messages }),
      autocompact: async messages => ({ messages, wasCompacted: false }),
      callModel: async function* ({ messages }) {
        modelRequests.push(messages)
        if (settle && modelRequests.length === 1) {
          yield createAssistantMessage({ content: [{ type: 'tool_use', id: 'toolu_settle', name: 'Settle', input: {} }] })
          return
        }
        yield createAssistantMessage({ content: 'done' })
      },
    },
  })
  let step = await iterator.next()
  while (!step.done) step = await iterator.next()
  return modelRequests
}

const pollEventsOf = (messages: Message[]) =>
  messages.flatMap(m => (m.type === 'attachment' && m.attachment.type === 'poll_events' ? [m.attachment] : []))

describe('poll events fold into the turn (official 2.1.325)', () => {
  test('an event queued while idle arrives at the next prompt as a Poll pair on the previous assistant message', async () => {
    const previous = createAssistantMessage({ content: 'earlier answer' })
    const delivered = enqueuePollEvent({ kind: 'repl-eval', element: element(1) })
    const envelope = getCommandQueueSnapshot()[0]!.pollEvent!.envelope
    const [first] = await run([createUserMessage({ content: 'hi' }), previous, createUserMessage({ content: 'next' })])

    expect(pollEventsOf(first!)).toEqual([
      { type: 'poll_events', envelopes: [envelope], kinds: ['repl-eval'], remainingWakeCount: 0, timestamp: expect.any(String), provenance: [null] },
    ])
    expect(getCommandQueueSnapshot()).toEqual([])
    await delivered

    const api = normalizeMessagesForAPI(first!)
    expect(api.map(m => m.type)).toEqual(['user', 'assistant', 'user'])
    expect(api[1]!.message.content).toContainEqual({ type: 'tool_use', id: `poll_${previous.uuid}`, name: 'Poll', input: {} })
    expect(api[2]!.message.content).toContainEqual({
      type: 'tool_result',
      tool_use_id: `poll_${previous.uuid}`,
      content: formatPollDelivery([envelope], 0),
    })
  })

  test('an event queued during a tool call goes with the tool results as one delivery', async () => {
    const [, second] = await run([createUserMessage({ content: 'go' })], { settle: true })
    const [attachment] = pollEventsOf(second!)
    expect(attachment).toMatchObject({ kinds: ['repl-eval'], remainingWakeCount: 0 })
    expect(getCommandQueueSnapshot()).toEqual([])

    const api = normalizeMessagesForAPI(second!)
    const id = `poll_${second!.findLast(m => m.type === 'assistant')!.uuid}`
    expect(api.at(-2)!.message.content).toContainEqual({ type: 'tool_use', id, name: 'Poll', input: {} })
    expect((api.at(-1)!.message.content as { type: string; tool_use_id?: string }[]).map(block => [block.type, block.tool_use_id])).toEqual([
      ['tool_result', 'toolu_settle'],
      ['tool_result', id],
    ])
  })

  test("another agent's events stay queued", async () => {
    void enqueuePollEvent({ kind: 'repl-eval', element: element(1), agentId: 'a-sub' as AgentId })
    const [first] = await run([createUserMessage({ content: 'hi' })])
    expect(pollEventsOf(first!)).toEqual([])
    expect(getCommandQueueSnapshot()).toHaveLength(1)

    const [own] = await run([createUserMessage({ content: 'work' })], { agentId: 'a-sub' as AgentId })
    expect(pollEventsOf(own!)).toHaveLength(1)
    expect(getCommandQueueSnapshot()).toEqual([])
  })
})

describe('a passive notice folds into the next turn (official 2.1.329)', () => {
  test("it goes after the turn's prompt, in its first request, and only the main thread takes it", async () => {
    const notice = '<task-notification>\n<task-id>a1</task-id>\n<status>killed</status>\n</task-notification>'
    enqueue({ value: notice, mode: 'task-notification', priority: 'next', passive: true })
    const [own] = await run([createUserMessage({ content: 'work' })], { agentId: 'a-sub' as AgentId })
    expect(own!.filter(m => m.type === 'attachment')).toEqual([])
    expect(getCommandQueueSnapshot()).toHaveLength(1)

    const [first] = await run([createUserMessage({ content: 'FOLLOWUP' })])
    expect(getCommandQueueSnapshot()).toEqual([])
    const api = normalizeMessagesForAPI(first!)
    const texts = api.map(m => typeof m.message.content === 'string'
      ? m.message.content
      : (m.message.content as { type: string; text?: string }[]).map(b => b.text ?? '').join('\n'))
    expect(texts[0]).toStartWith('FOLLOWUP')
    expect(texts.join('\n')).toContain('[SYSTEM NOTIFICATION - NOT USER INPUT]')
    expect(texts.join('\n').indexOf(notice)).toBeGreaterThan(texts.join('\n').indexOf('FOLLOWUP'))
  })
})

describe('an iteration that starts aborted (official 2.1.325)', () => {
  test('Esc that ends the wait for the scripts ends the turn as an interrupted request', async () => {
    const toolUseContext = createToolUseContext()
    // A prompt.context mod, and a running script the reply waits for. Esc lands
    // during that wait, so the second iteration starts aborted.
    const session = getReplSession(MAIN_REPL_SESSION)
    dispatchReplEval(session, 1, 'await sleep(40000)')
    startReplEval(session, 1)
    let escTimer: ReturnType<typeof setTimeout> | undefined
    toolUseContext.modsSnapshot = {
      hasHooks: (hook: string) => {
        if (hook === 'session.append') escTimer ??= setTimeout(() => toolUseContext.abortController.abort('user-cancel'), 50)
        return hook === 'prompt.context' && toolUseContext.abortController.signal.aborted
      },
    } as unknown as ToolUseContext['modsSnapshot']
    let requests = 0
    const yielded: Message[] = []
    const iterator = query({
      messages: [createUserMessage({ content: 'go' })],
      systemPrompt: asSystemPrompt([]), userContext: {}, systemContext: {},
      canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
      toolUseContext,
      querySource: 'repl_main_thread' as QuerySource,
      deps: {
        uuid: () => crypto.randomUUID(),
        microcompact: async messages => ({ messages }),
        autocompact: async messages => ({ messages, wasCompacted: false }),
        callModel: async function* () {
          requests++
          yield createAssistantMessage({ content: [{ type: 'tool_use', id: 'toolu_settle', name: 'Settle', input: {} }] })
        },
      },
    })
    let step = await iterator.next()
    for (; !step.done; step = await iterator.next()) if ((step.value as Message).type) yielded.push(step.value as Message)

    expect(requests).toBe(1)
    expect(step.value).toEqual({ reason: 'aborted_streaming' })
    const last = yielded.at(-1)!
    expect(last.type).toBe('user')
    expect(JSON.stringify(last.type === 'user' && last.message.content)).toContain('[Request interrupted by user]')
  })
})
