import { afterEach, beforeEach, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import type { QuerySource } from './constants/querySource.js'
import type { Tool, ToolUseContext } from './Tool.js'
import type { AssistantMessage, Message } from './types/message.js'
import { query } from './query.js'
import { getErrorMessageIfRefusal } from './services/api/errors.js'
import { asSystemPrompt } from './utils/systemPromptType.js'
import { createFileStateCacheWithSizeLimit } from './utils/fileStateCache.js'
import { createAssistantMessage } from './utils/messages.js'
import { getDefaultAppState, type AppState } from './state/AppStateStore.js'
import { resetStateForTests } from './bootstrap/state.js'

beforeEach(() => {
  resetStateForTests()
})

afterEach(() => {
  delete process.env.CLAUDE_CODE_DISABLE_REFUSAL_RETRY
})

type Event = { type: string; content?: unknown; message?: { content: unknown } }

const refusal = () => getErrorMessageIfRefusal('refusal', 'claude-sonnet-4-6', 'msg_refused')!

// Each entry is what one model request streams.
async function run(responses: AssistantMessage[][], querySource = 'sdk') {
  let calls = 0
  const release = Promise.withResolvers<void>()
  const tool = {
    name: 'Fixture',
    inputSchema: z.object({ value: z.string() }),
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    userFacingName: () => 'Fixture',
    checkPermissions: async () => ({ behavior: 'allow' }),
    call: async () => {
      calls++
      await release.promise
      return { data: 'ran' }
    },
    mapToolResultToToolResultBlockParam: (data: string, id: string) => ({ type: 'tool_result', tool_use_id: id, content: data }),
  } as unknown as Tool
  let appState: AppState = getDefaultAppState()
  const toolUseContext = {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'claude-sonnet-4-6',
      tools: [tool],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allAgents: [], allowedAgentTypes: undefined },
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
    messages: [],
  } as unknown as ToolUseContext
  const requests: Event[][] = []
  const events: Event[] = []
  const iterator = query({
    messages: [
      {
        type: 'user',
        uuid: '00000000-0000-4000-8000-000000000001',
        timestamp: '2026-11-22T00:00:00.000Z',
        message: { role: 'user', content: 'hi' },
      } as Message,
    ],
    systemPrompt: asSystemPrompt([]),
    userContext: {},
    systemContext: {},
    canUseTool: async () => ({ behavior: 'allow', updatedInput: { value: 'x' } }),
    toolUseContext,
    querySource: querySource as QuerySource,
    deps: {
      uuid: () => crypto.randomUUID(),
      microcompact: async messages => ({ messages }),
      autocompact: async messages => ({ messages, wasCompacted: false }),
      callModel: async function* ({ messages }) {
        requests.push(messages as Event[])
        for (const message of responses[requests.length - 1] ?? [createAssistantMessage({ content: 'done' })]) {
          // Let a tool call from the message before start running.
          await new Promise(resolve => setTimeout(resolve, 20))
          yield message
        }
      },
    },
  })
  while (true) {
    const next = await iterator.next()
    if (next.done) break
    if (next.value.type !== 'stream_request_start') events.push(next.value as Event)
  }
  release.resolve()
  const text = (message: Event | undefined) => JSON.stringify(message?.message?.content ?? message?.content)
  return { events, requests, calls, text }
}

test('a response stopped by a safety classifier is retried once, with the model told why', async () => {
  const { events, requests, text } = await run([[createAssistantMessage({ content: 'partial' }), refusal()]])
  expect(requests).toHaveLength(2)
  expect(events.map(event => event.type)).toEqual(['assistant', 'system', 'user', 'assistant'])
  expect(events[1]).toMatchObject({ subtype: 'informational', level: 'notice' })
  expect(events[1]!.content).toEndWith("'s safeguards stopped the response above · continuing once with that noted")
  expect(events[2]).toMatchObject({ isMeta: true, refusedMessageId: 'msg_refused' })
  expect(text(events[2])).toStartWith('"Your response above was stopped by a safety classifier')
  // The retry sees what was already produced and the note, not the error.
  expect(requests[1]!.map(message => message.type)).toEqual(['user', 'assistant', 'user'])
  expect(text(requests[1]!.at(-1))).toBe(text(events[2]))
  expect(text(events[3])).toBe('[{"type":"text","text":"done"}]')
})

test('a second refusal in the same query ends it with the error', async () => {
  const { events, requests } = await run([[refusal()], [refusal()]])
  expect(requests).toHaveLength(2)
  expect(events.at(-1)).toMatchObject({ type: 'assistant', isApiErrorMessage: true })
  // The retry notice, then the announcement that nothing is tried after this one.
  expect(events.filter(event => event.type === 'system')).toHaveLength(2)
  expect(events.at(-2)).toMatchObject({
    type: 'system',
    content: '',
    modelRefusalNoFallback: { originalModel: 'claude-sonnet-4-6', requestId: null, category: null, explanation: null },
  })
})

test('a tool call the stopped response had started gets an Interrupted result, and the note says so', async () => {
  const toolUse = createAssistantMessage({ content: [{ type: 'tool_use', id: 'toolu_1', name: 'Fixture', input: { value: 'x' } }] })
  const { events, requests, calls, text } = await run([[toolUse, refusal()]])
  expect(calls).toBe(1)
  expect(events.map(event => event.type)).toEqual(['assistant', 'user', 'system', 'user', 'assistant'])
  expect(events[1]).toMatchObject({ toolDenialKind: 'interrupted' })
  expect(text(events[1])).toContain('"is_error":true')
  expect(text(events[1])).toContain('Interrupted: the response that made this tool call was stopped by a safety classifier')
  expect(text(events[3])).toContain('Exception: a tool call whose result reads \\"Interrupted\\"')
  expect(requests[1]!.map(message => message.type)).toEqual(['user', 'assistant', 'user', 'user'])
})

test.each([
  ['CLAUDE_CODE_DISABLE_REFUSAL_RETRY is set', 'sdk', '1'],
  ['the query is an auxiliary one', 'compact', undefined],
])('no retry when %s', async (_name, querySource, disabled) => {
  if (disabled) process.env.CLAUDE_CODE_DISABLE_REFUSAL_RETRY = disabled
  const { events, requests } = await run([[refusal()]], querySource)
  expect(requests).toHaveLength(1)
  expect(events.map(event => event.type)).toEqual(['system', 'assistant'])
  expect(events[0]).toMatchObject({ modelRefusalNoFallback: { originalModel: 'claude-sonnet-4-6' } })
  expect(events[1]).toMatchObject({ isApiErrorMessage: true })
})
