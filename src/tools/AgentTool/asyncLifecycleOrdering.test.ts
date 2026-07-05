import assert from 'node:assert/strict'

import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { AppState } from '../../state/AppState.js'
import {
  isLocalAgentTask,
  registerAsyncAgent,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { AgentToolResult } from './agentToolUtils.js'
import { runAsyncAgentLifecycle } from './agentToolUtils.js'

function makeAssistantMessage() {
  return {
    type: 'assistant' as const,
    uuid: crypto.randomUUID(),
    requestId: 'req_test',
    message: {
      id: 'msg_test',
      type: 'message' as const,
      role: 'assistant' as const,
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text' as const, text: 'done' }],
      stop_reason: 'end_turn' as const,
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        server_tool_use: null,
        service_tier: 'standard' as const,
        cache_creation: null,
      },
    },
  }
}

const selectedAgent = {
  agentType: 'general-purpose',
  whenToUse: 'general',
  source: 'built-in' as const,
  baseDir: 'built-in' as const,
  getSystemPrompt: () => 'general',
}

let state = {
  tasks: {},
  toolPermissionContext: getEmptyToolPermissionContext(),
  mcp: { tools: [], clients: [] },
} as unknown as AppState

const setAppState = (fn: (prev: AppState) => AppState) => {
  state = fn(state)
}

registerAsyncAgent({
  agentId: 'agent-ordering-test',
  description: 'Ordering test',
  prompt: 'finish',
  selectedAgent,
  setAppState,
  toolUseId: 'toolu_test',
})

let resolveWorktree: (() => void) | undefined
const worktreeStarted = new Promise<void>(resolve => {
  resolveWorktree = resolve
})

const lifecycle = runAsyncAgentLifecycle({
  taskId: 'agent-ordering-test',
  abortController: new AbortController(),
  async *makeStream() {
    yield makeAssistantMessage() as never
  },
  metadata: {
    prompt: 'finish',
    resolvedAgentModel: 'claude-sonnet-4-6',
    isBuiltInAgent: true,
    startTime: Date.now(),
    agentType: 'general-purpose',
    isAsync: true,
  },
  description: 'Ordering test',
  toolUseContext: {
    options: { tools: [] },
    getAppState: () => state,
    toolUseId: 'toolu_test',
  } as never,
  rootSetAppState: setAppState,
  agentIdForCleanup: 'agent-ordering-test',
  enableSummarization: false,
  getWorktreeResult: () =>
    new Promise(resolve => {
      resolveWorktree?.()
      setTimeout(() => resolve({}), 50)
    }),
})

await worktreeStarted

const task = state.tasks['agent-ordering-test']
assert.ok(isLocalAgentTask(task))
assert.equal(task.status, 'completed')
assert.equal((task.result as AgentToolResult).agentId, 'agent-ordering-test')

await lifecycle

console.log('asyncLifecycleOrdering.test.ts passed')
