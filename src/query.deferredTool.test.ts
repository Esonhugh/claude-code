import { beforeEach, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import type { QuerySource } from './constants/querySource.js'
import type { Tool, ToolUseContext } from './Tool.js'
import type { Message } from './types/message.js'
import { query } from './query.js'
import { asSystemPrompt } from './utils/systemPromptType.js'
import { createFileStateCacheWithSizeLimit } from './utils/fileStateCache.js'
import { createAssistantMessage } from './utils/messages.js'
import { getErrorMessageIfRefusal } from './services/api/errors.js'
import { getDefaultAppState, type AppState } from './state/AppStateStore.js'
import { registerHookCallbacks, resetStateForTests } from './bootstrap/state.js'

beforeEach(() => {
  resetStateForTests()
})

// The stream delivers the tool_use, then stays open for `streamTailMs`.
async function runDeferred(streamTailMs: number, endsRefused = false) {
  let calls = 0
  const tool = {
    name: 'DeferFixture',
    inputSchema: z.object({ value: z.string() }),
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    userFacingName: () => 'DeferFixture',
    checkPermissions: async () => ({ behavior: 'allow' }),
    call: async () => {
      calls++
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
  registerHookCallbacks({
    PreToolUse: [{ hooks: [{
      type: 'callback',
      callback: async () => ({
        hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'defer' as const },
      }),
    }] }],
  })
  let modelRequests = 0
  const events: unknown[] = []
  const iterator = query({
    messages: [
      {
        type: 'user',
        uuid: '00000000-0000-4000-8000-000000000001',
        timestamp: '2026-11-22T00:00:00.000Z',
        message: { role: 'user', content: 'run the tool' },
      } as Message,
    ],
    systemPrompt: asSystemPrompt([]),
    userContext: {},
    systemContext: {},
    canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
    toolUseContext,
    querySource: 'sdk' as QuerySource,
    deps: {
      uuid: () => crypto.randomUUID(),
      microcompact: async messages => ({ messages }),
      autocompact: async messages => ({ messages, wasCompacted: false }),
      callModel: async function* () {
        modelRequests++
        if (modelRequests > 1) {
          yield createAssistantMessage({ content: 'done' })
          return
        }
        yield createAssistantMessage({
          content: [{ type: 'tool_use', id: 'toolu_defer', name: 'DeferFixture', input: { value: 'x' } }],
        })
        if (streamTailMs) {
          await new Promise(resolve => setTimeout(resolve, streamTailMs))
          // Like the message_delta that follows the last content block.
          yield { type: 'stream_event', event: { type: 'message_delta' } } as never
        }
        if (endsRefused) yield getErrorMessageIfRefusal('refusal', 'claude-sonnet-4-6', 'msg_refused')!
      },
    },
  })
  let terminal: unknown
  while (true) {
    const next = await iterator.next()
    if (next.done) {
      terminal = next.value
      break
    }
    events.push(next.value)
  }
  return { events, terminal, modelRequests, calls }
}

test.each([
  ['after the stream ended', 0],
  ['while the stream is still open', 100],
])('a deferred call ends the turn with the call open, hook answering %s', async (_name, streamTailMs) => {
  const run = await runDeferred(streamTailMs)
  expect(run.terminal).toEqual({ reason: 'tool_deferred' })
  expect(run.modelRequests).toBe(1)
  expect(run.calls).toBe(0)
  expect(JSON.stringify(run.events)).toContain('hook_deferred_tool')
  expect(JSON.stringify(run.events)).not.toContain('tool_result')
})

test('a refusal after a deferred call is announced before its error', async () => {
  const run = await runDeferred(100, true)
  expect(run.terminal).toEqual({ reason: 'tool_deferred' })
  expect(run.modelRequests).toBe(1)
  const tail = run.events.slice(-2) as Array<{ type: string; modelRefusalNoFallback?: unknown; isApiErrorMessage?: boolean }>
  expect(tail.map(event => event.type)).toEqual(['system', 'assistant'])
  expect(tail[0]!.modelRefusalNoFallback).toMatchObject({ originalModel: 'claude-sonnet-4-6' })
  expect(tail[1]!.isApiErrorMessage).toBe(true)
})
