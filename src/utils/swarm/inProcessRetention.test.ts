import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { ToolUseContext } from '../../Tool.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { createUserMessage } from '../messages.js'

let runAgentMode: 'complete' | 'fail' = 'complete'
let lifecycleAbortController: AbortController | undefined

mock.module('../../constants/prompts.js', () => ({
  getSystemPrompt: async () => [],
}))
mock.module('../../tools/AgentTool/runAgent.js', () => ({
  async *runAgent() {
    if (runAgentMode === 'fail') {
      throw new Error('runner boom')
    }
    yield {
      type: 'assistant',
      uuid: crypto.randomUUID(),
      requestId: 'req_in_process_retention_test',
      message: {
        id: 'msg_in_process_retention_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          server_tool_use: null,
          service_tier: 'standard',
          cache_creation: null,
        },
      },
    }
    lifecycleAbortController?.abort()
  },
}))
mock.module('../task/framework.js', () => ({
  STOPPED_DISPLAY_MS: 0,
  evictTerminalTask: () => {},
  registerTask: (task: { id: string }, setAppState: (updater: (prev: ReturnType<typeof getDefaultAppState>) => ReturnType<typeof getDefaultAppState>) => void) => {
    setAppState(prev => ({
      ...prev,
      tasks: {
        ...prev.tasks,
        [task.id]: task as never,
      },
    }))
  },
}))
mock.module('../task/diskOutput.js', () => ({
  evictTaskOutput: async () => {},
}))
mock.module('../sdkEventQueue.js', () => ({
  emitTaskTerminatedSdk: () => {},
}))
mock.module('./teamHelpers.js', () => ({
  removeMemberByAgentId: () => {},
}))

const { spawnInProcessTeammate, killInProcessTeammate } = await import('./spawnInProcess.js')
const { runInProcessTeammate } = await import('./inProcessRunner.js')

function createState() {
  return {
    ...getDefaultAppState(),
    mainLoopModel: 'claude-sonnet-4-6' as const,
    toolPermissionContext: getEmptyToolPermissionContext(),
    mcp: {
      ...getDefaultAppState().mcp,
      tools: [],
      clients: [],
    },
    tasks: {},
    agentNameRegistry: new Map(),
  }
}

function createToolUseContext(
  getState: () => ReturnType<typeof createState>,
  setState: (updater: (prev: ReturnType<typeof createState>) => ReturnType<typeof createState>) => void,
): ToolUseContext {
  return {
    options: {
      tools: [],
      mainLoopModel: 'claude-sonnet-4-6',
      mcpClients: [],
    },
    abortController: new AbortController(),
    readFileState: {} as never,
    getAppState: getState,
    setAppState: setState,
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => 0,
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as unknown as ToolUseContext
}

async function spawnTask(retain?: true) {
  let state = createState()
  const setState = (
    updater: (prev: typeof state) => typeof state,
  ) => {
    state = updater(state)
  }
  const spawnResult = await spawnInProcessTeammate(
    {
      name: 'researcher',
      teamName: 'retention-team',
      prompt: 'inspect only',
      planModeRequired: false,
      permissionMode: 'default',
    },
    {
      setAppState: setState,
    },
  )
  assert.equal(spawnResult.success, true)
  if (!spawnResult.taskId || !spawnResult.abortController || !spawnResult.teammateContext) {
    throw new Error('Expected spawned teammate runtime state')
  }

  const seedMessages = [
    createUserMessage({ content: 'first message' }),
    createUserMessage({ content: 'second message' }),
  ]
  state = {
    ...state,
    tasks: {
      ...state.tasks,
      [spawnResult.taskId]: {
        ...state.tasks[spawnResult.taskId],
        ...(retain ? { retain } : {}),
        messages: seedMessages,
      },
    },
  }

  return {
    getState: () => state,
    setState,
    seedMessages,
    taskId: spawnResult.taskId,
    abortController: spawnResult.abortController,
    teammateContext: spawnResult.teammateContext,
  }
}

async function runCase(mode: 'complete' | 'fail', retain?: true) {
  const spawned = await spawnTask(retain)
  runAgentMode = mode
  lifecycleAbortController = spawned.abortController
  const result = await runInProcessTeammate({
    identity: {
      agentId: 'researcher@retention-team',
      agentName: 'researcher',
      teamName: 'retention-team',
      color: 'blue',
      planModeRequired: false,
      parentSessionId: 'session-retention-test',
    },
    taskId: spawned.taskId,
    prompt: 'inspect only',
    description: 'Retention test teammate',
    teammateContext: spawned.teammateContext,
    toolUseContext: createToolUseContext(spawned.getState, spawned.setState),
    abortController: spawned.abortController,
  })
  lifecycleAbortController = undefined
  return {
    result,
    task: spawned.getState().tasks[spawned.taskId],
    seedMessages: spawned.seedMessages,
  }
}

const completedRetained = await runCase('complete', true)
assert.equal(completedRetained.result.success, true)
assert.equal(completedRetained.task?.type, 'in_process_teammate')
assert.equal(completedRetained.task?.status, 'completed')
assert.deepEqual(
  completedRetained.task?.messages?.slice(0, 2),
  completedRetained.seedMessages,
)
assert.equal(completedRetained.task?.messages?.length, 4)

const completedUnretained = await runCase('complete')
assert.equal(completedUnretained.task?.type, 'in_process_teammate')
assert.equal(completedUnretained.task?.status, 'completed')
assert.equal(completedUnretained.task?.messages?.length, 1)
assert.equal(completedUnretained.task?.messages?.[0]?.type, 'assistant')

const failedRetained = await runCase('fail', true)
assert.equal(failedRetained.result.success, false)
assert.equal(failedRetained.task?.type, 'in_process_teammate')
assert.equal(failedRetained.task?.status, 'failed')
assert.equal(failedRetained.task?.error, 'runner boom')
assert.deepEqual(failedRetained.task?.messages?.slice(0, 2), failedRetained.seedMessages)
assert.equal(failedRetained.task?.messages?.length, 3)

const failedUnretained = await runCase('fail')
assert.equal(failedUnretained.task?.type, 'in_process_teammate')
assert.equal(failedUnretained.task?.status, 'failed')
assert.equal(failedUnretained.task?.messages?.length, 1)
assert.equal(failedUnretained.task?.messages?.[0]?.type, 'user')

const killedRetainedSpawn = await spawnTask(true)
const killedRetained = killInProcessTeammate(
  killedRetainedSpawn.taskId,
  killedRetainedSpawn.setState,
)
assert.equal(killedRetained, true)
assert.equal(
  killedRetainedSpawn.getState().tasks[killedRetainedSpawn.taskId]?.type,
  'in_process_teammate',
)
assert.equal(
  killedRetainedSpawn.getState().tasks[killedRetainedSpawn.taskId]?.status,
  'killed',
)
assert.deepEqual(
  killedRetainedSpawn.getState().tasks[killedRetainedSpawn.taskId]?.messages,
  killedRetainedSpawn.seedMessages,
)

const killedUnretainedSpawn = await spawnTask()
const killedUnretained = killInProcessTeammate(
  killedUnretainedSpawn.taskId,
  killedUnretainedSpawn.setState,
)
assert.equal(killedUnretained, true)
assert.equal(
  killedUnretainedSpawn.getState().tasks[killedUnretainedSpawn.taskId]?.messages?.length,
  1,
)
assert.deepEqual(
  killedUnretainedSpawn.getState().tasks[killedUnretainedSpawn.taskId]?.messages?.[0],
  killedUnretainedSpawn.seedMessages[1],
)

console.log('inProcessRetention.test.ts passed')
