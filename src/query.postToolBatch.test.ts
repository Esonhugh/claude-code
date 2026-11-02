import { beforeEach, expect, test } from 'bun:test'
import type { PostToolBatchHookInput } from './entrypoints/agentSdkTypes.js'
import type { QuerySource } from './constants/querySource.js'
import type { ToolUseContext } from './Tool.js'
import type { Message } from './types/message.js'
import { query } from './query.js'
import { asSystemPrompt } from './utils/systemPromptType.js'
import { createFileStateCacheWithSizeLimit } from './utils/fileStateCache.js'
import { createAssistantMessage } from './utils/messages.js'
import { getDefaultAppState, type AppState } from './state/AppStateStore.js'
import { registerHookCallbacks, resetStateForTests } from './bootstrap/state.js'
import type { HookJSONOutput } from './entrypoints/agentSdkTypes.js'

function createToolUseContext(): ToolUseContext {
  let appState: AppState = getDefaultAppState()
  return {
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
      agentDefinitions: { activeAgents: [], allAgents: [], allowedAgentTypes: undefined },
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(10),
    getAppState: () => appState,
    setAppState: updater => {
      appState = updater(appState)
    },
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [],
  }
}

async function runBatch(output: HookJSONOutput) {
  const inputs: PostToolBatchHookInput[] = []
  registerHookCallbacks({
    PostToolBatch: [
      {
        hooks: [
          {
            type: 'callback',
            callback: async input => {
              inputs.push(input as PostToolBatchHookInput)
              return output
            },
          },
        ],
      },
    ],
  })
  const modelRequests: Message[][] = []
  const events: unknown[] = []
  const iterator = query({
    messages: [
      {
        type: 'user',
        uuid: '00000000-0000-4000-8000-000000000001',
        timestamp: '2026-10-29T00:00:00.000Z',
        message: { role: 'user', content: 'run two tools' },
      } as Message,
    ],
    systemPrompt: asSystemPrompt([]),
    userContext: {},
    systemContext: {},
    canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
    toolUseContext: createToolUseContext(),
    querySource: 'repl_main_thread' as QuerySource,
    deps: {
      uuid: () => crypto.randomUUID(),
      microcompact: async messages => ({ messages }),
      autocompact: async messages => ({ messages, wasCompacted: false }),
      callModel: async function* ({ messages }) {
        modelRequests.push(messages)
        if (modelRequests.length === 1) {
          yield createAssistantMessage({
            content: [
              { type: 'tool_use', id: 'toolu_a', name: 'missing_tool_a', input: { n: 1 } },
              { type: 'tool_use', id: 'toolu_b', name: 'missing_tool_b', input: { n: 2 } },
            ],
          })
          return
        }
        yield createAssistantMessage({ content: 'done' })
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
  return { inputs, modelRequests, events, terminal }
}

beforeEach(() => {
  resetStateForTests()
})

test('PostToolBatch fires once per batch and its additionalContext reaches the next request', async () => {
  const run = await runBatch({
    hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext: 'batch note' },
  })
  expect(run.inputs).toHaveLength(1)
  expect(run.inputs[0]!.hook_event_name).toBe('PostToolBatch')
  expect(run.inputs[0]!.tool_calls.map(call => [call.tool_use_id, call.tool_name, call.tool_input])).toEqual([
    ['toolu_a', 'missing_tool_a', { n: 1 }],
    ['toolu_b', 'missing_tool_b', { n: 2 }],
  ])
  expect(run.inputs[0]!.tool_calls[0]!.tool_response).toBeDefined()
  expect(run.modelRequests).toHaveLength(2)
  expect(JSON.stringify(run.modelRequests[1])).toContain('batch note')
})

test('a blocking PostToolBatch hook stops the agentic loop', async () => {
  const run = await runBatch({ decision: 'block', reason: 'stop here' })
  expect(run.modelRequests).toHaveLength(1)
  expect(run.terminal).toEqual({ reason: 'hook_stopped' })
  expect(JSON.stringify(run.events)).toContain('hook_stopped_continuation')
})
