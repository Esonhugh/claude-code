import { beforeEach, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import type { QuerySource } from './constants/querySource.js'
import { buildTool, type ToolUseContext } from './Tool.js'
import type { Message } from './types/message.js'
import { query } from './query.js'
import { asSystemPrompt } from './utils/systemPromptType.js'
import { createFileStateCacheWithSizeLimit } from './utils/fileStateCache.js'
import { createAssistantMessage } from './utils/messages.js'
import { getDefaultAppState, type AppState } from './state/AppStateStore.js'
import { registerHookCallbacks, resetStateForTests } from './bootstrap/state.js'
import { createTeammateContext, runWithTeammateContext } from './utils/teammateContext.js'

const fakeTool = (name: string) => buildTool({
  name, inputSchema: z.object({ to: z.string().optional(), message: z.unknown().optional() }),
  maxResultSizeChars: Infinity, isConcurrencySafe: () => true,
  description: async () => name, prompt: async () => name, renderToolUseMessage: () => null,
  call: async () => ({ data: 'ok' }),
  mapToolResultToToolResultBlockParam: (data: unknown, id: string) => ({ type: 'tool_result', tool_use_id: id, content: String(data) }),
})

function createToolUseContext(): ToolUseContext {
  let appState: AppState = getDefaultAppState()
  return {
    options: {
      commands: [], debug: false, mainLoopModel: 'claude-sonnet-4-6',
      tools: [fakeTool('SendMessage'), fakeTool('Other')],
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

type Call = { name: string; input: Record<string, unknown> }

async function run(calls: Call[], asTeammate = true) {
  const modelRequests: Message[][] = []
  const drive = async () => {
    const iterator = query({
      messages: [{
        type: 'user', uuid: '00000000-0000-4000-8000-000000000001', timestamp: '2026-11-12T00:00:00.000Z',
        message: { role: 'user', content: 'fix the module' },
      } as Message],
      systemPrompt: asSystemPrompt([]), userContext: {}, systemContext: {},
      canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
      toolUseContext: createToolUseContext(),
      querySource: 'agent:custom' as QuerySource,
      deps: {
        uuid: () => crypto.randomUUID(),
        microcompact: async messages => ({ messages }),
        autocompact: async messages => ({ messages, wasCompacted: false }),
        callModel: async function* ({ messages }) {
          modelRequests.push(messages)
          if (modelRequests.length === 1) {
            yield createAssistantMessage({
              content: calls.map((call, i) => ({ type: 'tool_use' as const, id: `toolu_${i}`, ...call })),
            })
            return
          }
          yield createAssistantMessage({ content: 'done' })
        },
      },
    })
    while (true) {
      const next = await iterator.next()
      if (next.done) return next.value
    }
  }
  const terminal = asTeammate
    ? await runWithTeammateContext(createTeammateContext({
        agentId: 'dates@team', agentName: 'dates', teamName: 'team', planModeRequired: false,
        parentSessionId: 'session', abortController: new AbortController(),
      }), drive)
    : await drive()
  return { modelRequests, terminal }
}

const report: Call = { name: 'SendMessage', input: { to: 'team-lead', message: 'dates.py fixed, 2 tests pass' } }

beforeEach(() => {
  resetStateForTests()
})

test('a teammate response that only reports to the team lead ends the turn without another model request', async () => {
  let idleHooks = 0
  registerHookCallbacks({
    TeammateIdle: [{ hooks: [{ type: 'callback', callback: async () => { idleHooks++; return {} } }] }],
  })
  const result = await run([report])
  expect(result.modelRequests).toHaveLength(1)
  expect(result.terminal).toEqual({ reason: 'completed' })
  expect(idleHooks).toBe(1)
})

test('the turn continues when the response did anything besides reporting to the team lead', async () => {
  expect((await run([report, { name: 'Other', input: {} }])).modelRequests).toHaveLength(2)
  expect((await run([{ name: 'SendMessage', input: { to: 'money', message: 'your turn' } }])).modelRequests).toHaveLength(2)
  expect((await run([{ name: 'SendMessage', input: { to: 'team-lead', message: { type: 'shutdown_response', request_id: 'r', approve: false } } }])).modelRequests).toHaveLength(2)
  expect((await run([report], false)).modelRequests).toHaveLength(2)
})

test('a TeammateIdle hook that blocks sends the teammate back to work', async () => {
  let blocked = false
  registerHookCallbacks({
    TeammateIdle: [{ hooks: [{ type: 'callback', callback: async () => {
      if (blocked) return {}
      blocked = true
      return { decision: 'block' as const, reason: 'run the linter first' }
    } }] }],
  })
  const result = await run([report])
  expect(result.modelRequests).toHaveLength(2)
  expect(JSON.stringify(result.modelRequests[1])).toContain('run the linter first')
})
