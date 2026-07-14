import assert from 'node:assert/strict'
import { mock } from 'bun:test'

import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { AppState } from '../../state/AppState.js'
import { getCommandQueue } from '../../utils/messageQueueManager.js'
import { AbortError } from '../../utils/errors.js'
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

let summaryStarts = 0
let summaryStops = 0

mock.module('../../services/AgentSummary/agentSummary.js', () => ({
  startAgentSummarization() {
    summaryStarts += 1
    return {
      stop() {
        summaryStops += 1
      },
    }
  },
}))

let state = {
  tasks: {},
  toolPermissionContext: getEmptyToolPermissionContext(),
  mcp: { tools: [], clients: [] },
  speculation: { status: 'idle' },
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
  spawnDepth: 1,
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

registerAsyncAgent({
  agentId: 'agent-postprocess-warning-test',
  description: 'Post-processing warning test',
  prompt: 'finish despite cleanup failure',
  selectedAgent,
  setAppState,
  toolUseId: 'toolu_warning',
  spawnDepth: 1,
})

await runAsyncAgentLifecycle({
  taskId: 'agent-postprocess-warning-test',
  abortController: new AbortController(),
  async *makeStream() {
    yield makeAssistantMessage() as never
  },
  metadata: {
    prompt: 'finish despite cleanup failure',
    resolvedAgentModel: 'claude-sonnet-4-6',
    isBuiltInAgent: true,
    startTime: Date.now(),
    agentType: 'general-purpose',
    isAsync: true,
  },
  description: 'Post-processing warning test',
  toolUseContext: {
    options: { tools: [] },
    getAppState: () => state,
    toolUseId: 'toolu_warning',
  } as never,
  rootSetAppState: setAppState,
  agentIdForCleanup: 'agent-postprocess-warning-test',
  enableSummarization: false,
  getWorktreeResult: async () => {
    throw new Error('/private/worktree cleanup failed')
  },
})

const warningTask = state.tasks['agent-postprocess-warning-test']
assert.ok(isLocalAgentTask(warningTask))
assert.equal(warningTask.status, 'completed')
assert.deepEqual(warningTask.warnings, [
  'Agent post-processing could not complete. Review the agent output before continuing.',
])
const warningNotifications = getCommandQueue().filter(command =>
  String(command.value).includes('agent-postprocess-warning-test'),
)
assert.equal(warningNotifications.length, 1)
assert.match(String(warningNotifications[0]?.value), /<status>completed<\/status>/)
assert.doesNotMatch(String(warningNotifications[0]?.value), /private\/worktree/)

registerAsyncAgent({
  agentId: 'agent-failed-usage-test',
  description: 'Failed usage test',
  prompt: 'fail after response',
  selectedAgent,
  setAppState,
  toolUseId: 'toolu_failed_usage',
  spawnDepth: 1,
})

await runAsyncAgentLifecycle({
  taskId: 'agent-failed-usage-test',
  abortController: new AbortController(),
  async *makeStream() {
    yield makeAssistantMessage() as never
    throw new Error('stream failed')
  },
  metadata: {
    prompt: 'fail after response',
    resolvedAgentModel: 'claude-sonnet-4-6',
    isBuiltInAgent: true,
    startTime: Date.now(),
    agentType: 'general-purpose',
    isAsync: true,
  },
  description: 'Failed usage test',
  toolUseContext: {
    options: { tools: [] },
    getAppState: () => state,
    toolUseId: 'toolu_failed_usage',
  } as never,
  rootSetAppState: setAppState,
  agentIdForCleanup: 'agent-failed-usage-test',
  enableSummarization: false,
  getWorktreeResult: async () => ({}),
})

const failedNotification = getCommandQueue().find(command =>
  String(command.value).includes('agent-failed-usage-test'),
)
assert.ok(failedNotification)
assert.match(String(failedNotification.value), /<status>failed<\/status>/)
assert.match(String(failedNotification.value), /<total_tokens>12<\/total_tokens>/)

registerAsyncAgent({
  agentId: 'agent-summary-replacement-test',
  description: 'Summary replacement test',
  prompt: 'replace summary safely',
  selectedAgent,
  setAppState,
  toolUseId: 'toolu_summary_replacement',
  spawnDepth: 1,
})

await runAsyncAgentLifecycle({
  taskId: 'agent-summary-replacement-test',
  abortController: new AbortController(),
  async *makeStream(onCacheSafeParams) {
    onCacheSafeParams?.({} as never)
    onCacheSafeParams?.({} as never)
    yield makeAssistantMessage() as never
  },
  metadata: {
    prompt: 'replace summary safely',
    resolvedAgentModel: 'claude-sonnet-4-6',
    isBuiltInAgent: true,
    startTime: Date.now(),
    agentType: 'general-purpose',
    isAsync: true,
  },
  description: 'Summary replacement test',
  toolUseContext: {
    options: { tools: [] },
    getAppState: () => state,
    toolUseId: 'toolu_summary_replacement',
  } as never,
  rootSetAppState: setAppState,
  agentIdForCleanup: 'agent-summary-replacement-test',
  enableSummarization: true,
  getWorktreeResult: async () => ({}),
})

assert.equal(summaryStarts, 2)
assert.equal(summaryStops, 2)

registerAsyncAgent({
  agentId: 'agent-failed-cleanup-test',
  description: 'Failed cleanup test',
  prompt: 'fail despite cleanup failure',
  selectedAgent,
  setAppState,
  toolUseId: 'toolu_failed_cleanup',
  spawnDepth: 1,
})

await runAsyncAgentLifecycle({
  taskId: 'agent-failed-cleanup-test',
  abortController: new AbortController(),
  async *makeStream() {
    throw new Error('stream failed before cleanup')
    yield makeAssistantMessage() as never
  },
  metadata: {
    prompt: 'fail despite cleanup failure',
    resolvedAgentModel: 'claude-sonnet-4-6',
    isBuiltInAgent: true,
    startTime: Date.now(),
    agentType: 'general-purpose',
    isAsync: true,
  },
  description: 'Failed cleanup test',
  toolUseContext: {
    options: { tools: [] },
    getAppState: () => state,
    toolUseId: 'toolu_failed_cleanup',
  } as never,
  rootSetAppState: setAppState,
  agentIdForCleanup: 'agent-failed-cleanup-test',
  enableSummarization: false,
  getWorktreeResult: async () => {
    throw new Error('/private/failed cleanup failed')
  },
})

const failedCleanupTask = state.tasks['agent-failed-cleanup-test']
assert.ok(isLocalAgentTask(failedCleanupTask))
assert.equal(failedCleanupTask.status, 'failed')
const failedCleanupNotification = getCommandQueue().find(command =>
  String(command.value).includes('agent-failed-cleanup-test'),
)
assert.ok(failedCleanupNotification)
assert.match(
  String(failedCleanupNotification.value),
  /<status>failed<\/status>/,
)

registerAsyncAgent({
  agentId: 'agent-killed-cleanup-test',
  description: 'Killed cleanup test',
  prompt: 'stop despite cleanup failure',
  selectedAgent,
  setAppState,
  toolUseId: 'toolu_killed_cleanup',
  spawnDepth: 1,
})

await runAsyncAgentLifecycle({
  taskId: 'agent-killed-cleanup-test',
  abortController: new AbortController(),
  async *makeStream() {
    throw new AbortError('stopped')
    yield makeAssistantMessage() as never
  },
  metadata: {
    prompt: 'stop despite cleanup failure',
    resolvedAgentModel: 'claude-sonnet-4-6',
    isBuiltInAgent: true,
    startTime: Date.now(),
    agentType: 'general-purpose',
    isAsync: true,
  },
  description: 'Killed cleanup test',
  toolUseContext: {
    options: { tools: [] },
    getAppState: () => state,
    toolUseId: 'toolu_killed_cleanup',
  } as never,
  rootSetAppState: setAppState,
  agentIdForCleanup: 'agent-killed-cleanup-test',
  enableSummarization: false,
  getWorktreeResult: async () => {
    throw new Error('/private/killed cleanup failed')
  },
})

const killedCleanupTask = state.tasks['agent-killed-cleanup-test']
assert.ok(isLocalAgentTask(killedCleanupTask))
assert.equal(killedCleanupTask.status, 'killed')
const killedCleanupNotification = getCommandQueue().find(command =>
  String(command.value).includes('agent-killed-cleanup-test'),
)
assert.ok(killedCleanupNotification)
assert.match(
  String(killedCleanupNotification.value),
  /<status>killed<\/status>/,
)

const streamingMessage = makeAssistantMessage()
streamingMessage.uuid = crypto.randomUUID()
streamingMessage.message.content = [
  {
    type: 'tool_use',
    id: 'toolu_streaming',
    name: 'Read',
    input: { file_path: '/tmp/example' },
  },
] as never
streamingMessage.message.usage.input_tokens = 0
streamingMessage.message.usage.output_tokens = 0

registerAsyncAgent({
  agentId: 'agent-progress-test',
  description: 'Progress test',
  prompt: 'read once',
  selectedAgent,
  setAppState,
  toolUseId: 'toolu_parent',
  spawnDepth: 1,
})

await runAsyncAgentLifecycle({
  taskId: 'agent-progress-test',
  abortController: new AbortController(),
  async *makeStream() {
    yield streamingMessage as never
    streamingMessage.message.usage.input_tokens = 200
    streamingMessage.message.usage.output_tokens = 12
    yield {
      type: 'user',
      uuid: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_streaming',
            content: 'ok',
          },
        ],
      },
    } as never
  },
  metadata: {
    prompt: 'read once',
    resolvedAgentModel: 'claude-sonnet-4-6',
    isBuiltInAgent: true,
    startTime: Date.now(),
    agentType: 'general-purpose',
    isAsync: true,
  },
  description: 'Progress test',
  toolUseContext: {
    options: { tools: [] },
    getAppState: () => state,
    toolUseId: 'toolu_parent',
  } as never,
  rootSetAppState: setAppState,
  agentIdForCleanup: 'agent-progress-test',
  enableSummarization: false,
  getWorktreeResult: async () => ({}),
})

const progressTask = state.tasks['agent-progress-test']
assert.ok(isLocalAgentTask(progressTask))
assert.equal(progressTask.progress?.tokenCount, 212)
assert.equal(progressTask.progress?.toolUseCount, 1)

console.log('asyncLifecycleOrdering.test.ts passed')
