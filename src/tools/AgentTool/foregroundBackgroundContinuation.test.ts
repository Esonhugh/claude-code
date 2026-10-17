import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { setSdkAgentProgressSummariesEnabled } from '../../bootstrap/state.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import {
  backgroundAgentTask,
  isLocalAgentTask,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { Message } from '../../types/message.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { getCommandQueue } from '../../utils/messageQueueManager.js'
import { AgentTool } from './AgentTool.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'

// The subagent tool pool asks the Workflow tool for its plan default, which reads the subscription.
process.env.ANTHROPIC_API_KEY ??= 'test-only-not-a-real-key'

const makeAssistantMessage = (
  id: string,
  content: Array<Record<string, unknown>>,
): Message =>
  ({
    type: 'assistant',
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      id: `msg_${id}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content,
      stop_reason: content.some(block => block.type === 'tool_use')
        ? 'tool_use'
        : 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        server_tool_use: null,
        service_tier: 'standard',
        cache_creation: null,
      },
    },
  }) as unknown as Message

const makeToolResultMessage = (toolUseId: string): Message =>
  ({
    type: 'user',
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: 'ok',
        },
      ],
    },
  }) as unknown as Message

let toolUseYields = 0
let summaryStarts = 0
let summaryStops = 0
type RunMode = 'completed' | 'failed' | 'late-usage-failed' | 'park-throws'
let runMode: RunMode = 'completed'
let currentForegroundReachedTool: (() => void) | undefined
let currentBackgroundMayFinish: Promise<void> = Promise.resolve()
let overlappingNextCalls = 0
let onOverlappingNext: (() => void) | undefined

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

mock.module('./backgroundOwner.js', () => ({
  parkAgentForChildren() {
    if (runMode === 'park-throws') throw new Error('park bookkeeping failed')
    return false
  },
}))

async function* scriptedAgent(params: {
  onCacheSafeParams?: (params: Record<string, unknown>) => void
}) {
  params.onCacheSafeParams?.({})
  params.onCacheSafeParams?.({})
  toolUseYields += 1
  const toolUseId = `toolu_side_effect_${toolUseYields}`
  const toolUse = makeAssistantMessage('tool', [
    {
      type: 'tool_use',
      id: toolUseId,
      name: 'Bash',
      input: { command: 'side-effect' },
    },
  ] as never)
  yield toolUse
  yield makeToolResultMessage(toolUseId)
  currentForegroundReachedTool?.()
  await currentBackgroundMayFinish
  if (runMode === 'late-usage-failed') {
    // Streaming updates the yielded message's usage in place.
    ;(toolUse as { message: { usage: { output_tokens: number } } }).message.usage.output_tokens = 40
    throw new Error('background continuation failed')
  }
  if (runMode === 'failed') throw new Error('background continuation failed')
  yield makeAssistantMessage('done', [
    { type: 'text', text: 'done' },
  ] as never)
}

mock.module('./runAgent.js', () => ({
  runAgent(params: Parameters<typeof scriptedAgent>[0]) {
    const inner = scriptedAgent(params)
    let pendingNextCalls = 0
    // Records a next() requested while the previous one is still unresolved.
    const iterator: AsyncIterableIterator<Message> = {
      next() {
        if (pendingNextCalls > 0) {
          overlappingNextCalls += 1
          onOverlappingNext?.()
        }
        pendingNextCalls += 1
        return inner.next().finally(() => {
          pendingNextCalls -= 1
        }) as Promise<IteratorResult<Message>>
      },
      return: value => inner.return(value) as Promise<IteratorResult<Message>>,
      throw: error => inner.throw(error) as Promise<IteratorResult<Message>>,
      [Symbol.asyncIterator]() {
        return iterator
      },
    }
    return iterator
  },
}))

type TestContext = Parameters<typeof AgentTool.call>[1] & {
  getAppState: () => ReturnType<typeof getDefaultAppState>
}

function createContext(): TestContext {
  const defaultState = getDefaultAppState()
  let state = {
    ...defaultState,
    toolPermissionContext: getEmptyToolPermissionContext(),
    mcp: {
      ...defaultState.mcp,
      clients: [],
      tools: [],
    },
    agentDefinitions: {
      activeAgents: [GENERAL_PURPOSE_AGENT],
      inactiveAgents: [],
      allowedAgentTypes: undefined,
    },
    tasks: {},
    agentNameRegistry: new Map(),
  }
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
      agentDefinitions: {
        activeAgents: [GENERAL_PURPOSE_AGENT],
        inactiveAgents: [],
        allowedAgentTypes: undefined,
      },
    },
    messages: [],
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(10),
    getAppState: () => state,
    setAppState: updater => {
      state = typeof updater === 'function' ? updater(state) : updater
    },
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as never
}

async function runBackgroundContinuation(
  mode: RunMode,
  { retain = false }: { retain?: boolean } = {},
) {
  runMode = mode
  let releaseBackgroundContinuation: (() => void) | undefined
  currentBackgroundMayFinish = new Promise<void>(resolve => {
    releaseBackgroundContinuation = resolve
  })
  const foregroundReachedTool = new Promise<void>(resolve => {
    currentForegroundReachedTool = resolve
  })
  const context = createContext()
  const callPromise = AgentTool.call(
    {
      description: `background continuation ${mode}`,
      prompt: 'run one side effect then finish',
      subagent_type: 'general-purpose',
      // Official 2.1.292 defaults omitted background to async; this fixture
      // exercises foreground-to-background continuation without a restart.
      run_in_background: false,
    },
    context,
    async () => ({ behavior: 'allow' }),
    { message: { id: `msg_parent_${mode}` } } as never,
  )

  await foregroundReachedTool
  const taskId = Object.keys(context.getAppState().tasks)[0]
  assert.ok(taskId)
  assert.equal(
    backgroundAgentTask(taskId, context.getAppState, context.setAppState),
    true,
  )

  const launched = await callPromise
  assert.equal(launched.data.status, 'async_launched')
  if (retain) {
    context.setAppState(prev => {
      const task = prev.tasks[taskId]
      if (!isLocalAgentTask(task)) return prev
      return {
        ...prev,
        tasks: { ...prev.tasks, [taskId]: { ...task, retain: true } },
      }
    })
  }
  releaseBackgroundContinuation?.()

  for (let i = 0; i < 20; i++) {
    const task = context.getAppState().tasks[taskId]
    if (isLocalAgentTask(task) && task.status !== 'running') break
    await new Promise(resolve => setTimeout(resolve, 10))
  }

  return { context, taskId }
}

const notificationFor = (taskId: string) =>
  getCommandQueue().filter(command => String(command.value).includes(taskId))

setSdkAgentProgressSummariesEnabled(true)
const completedRun = await runBackgroundContinuation('completed', { retain: true })
const completedTask = completedRun.context.getAppState().tasks[completedRun.taskId]
assert.ok(isLocalAgentTask(completedTask))
assert.equal(completedTask.status, 'completed')
assert.equal(toolUseYields, 1)
assert.equal(completedTask.progress?.toolUseCount, 1)
assert.match(JSON.stringify(completedTask.result), /done/)
assert.equal(completedTask.result?.totalToolUseCount, 1)
assert.equal(summaryStarts, 2)
assert.equal(summaryStops, 2)
// A retained (viewed) task receives messages streamed after the handoff.
assert.match(JSON.stringify(completedTask.messages ?? []), /"text":"done"/)

const failedRun = await runBackgroundContinuation('failed')
const failedTask = failedRun.context.getAppState().tasks[failedRun.taskId]
assert.ok(isLocalAgentTask(failedTask))
assert.equal(failedTask.status, 'failed')
const failedNotification = getCommandQueue().find(command =>
  String(command.value).includes(failedRun.taskId),
)
assert.ok(failedNotification)
assert.match(String(failedNotification.value), /<status>failed<\/status>/)
assert.match(String(failedNotification.value), /<total_tokens>12<\/total_tokens>/)
assert.match(String(failedNotification.value), /<tool_uses>1<\/tool_uses>/)
assert.equal(summaryStarts, 4)
assert.equal(summaryStops, 4)
setSdkAgentProgressSummariesEnabled(false)

// Usage observed on the last assistant message after it was yielded must reach
// the failed notification, as in the async-from-start lifecycle.
const lateUsageRun = await runBackgroundContinuation('late-usage-failed')
const lateUsageNotifications = notificationFor(lateUsageRun.taskId)
assert.equal(lateUsageNotifications.length, 1)
assert.match(String(lateUsageNotifications[0]?.value), /<status>failed<\/status>/)
assert.match(String(lateUsageNotifications[0]?.value), /<total_tokens>50<\/total_tokens>/)

// A throw after the task is already completed must not report it as failed.
const parkThrowRun = await runBackgroundContinuation('park-throws')
const parkThrowTask = parkThrowRun.context.getAppState().tasks[parkThrowRun.taskId]
assert.ok(isLocalAgentTask(parkThrowTask))
assert.equal(parkThrowTask.status, 'completed')
assert.deepEqual(parkThrowTask.warnings, [
  'Agent post-processing could not complete. Review the agent output before continuing.',
])
for (let i = 0; i < 20 && notificationFor(parkThrowRun.taskId).length === 0; i++) {
  await new Promise(resolve => setTimeout(resolve, 10))
}
const parkThrowNotifications = notificationFor(parkThrowRun.taskId)
assert.equal(parkThrowNotifications.length, 1)
assert.match(String(parkThrowNotifications[0]?.value), /<status>completed<\/status>/)
assert.doesNotMatch(String(parkThrowNotifications[0]?.value), /park bookkeeping failed/)

// A background signal for a task that no longer qualifies must not make the
// foreground loop request further items while one is still in flight.
{
  runMode = 'completed'
  overlappingNextCalls = 0
  let release: (() => void) | undefined
  currentBackgroundMayFinish = new Promise<void>(resolve => {
    release = resolve
  })
  const reachedTool = new Promise<void>(resolve => {
    currentForegroundReachedTool = resolve
  })
  const context = createContext()
  const setBackgrounded = (taskId: string, isBackgrounded: boolean) =>
    context.setAppState(prev => {
      const task = prev.tasks[taskId]
      if (!isLocalAgentTask(task)) return prev
      return {
        ...prev,
        tasks: { ...prev.tasks, [taskId]: { ...task, isBackgrounded } },
      }
    })
  const callPromise = AgentTool.call(
    {
      description: 'stale background signal',
      prompt: 'run one side effect then finish',
      subagent_type: 'general-purpose',
      run_in_background: false,
    },
    context,
    async () => ({ behavior: 'allow' }),
    { message: { id: 'msg_parent_stale_signal' } } as never,
  )
  await reachedTool
  const taskId = Object.keys(context.getAppState().tasks)[0]
  assert.ok(taskId)
  assert.equal(
    backgroundAgentTask(taskId, context.getAppState, context.setAppState),
    true,
  )
  setBackgrounded(taskId, false)
  // Without the fix the loop spins; let it leave through the background path.
  onOverlappingNext = () => setBackgrounded(taskId, true)
  await new Promise(resolve => setTimeout(resolve, 0))
  release?.()
  const result = await callPromise
  onOverlappingNext = undefined
  assert.equal(overlappingNextCalls, 0)
  assert.equal(result.data.status, 'completed')
  assert.match(JSON.stringify(result.data), /done/)
}

console.log('foregroundBackgroundContinuation.test.ts passed')
