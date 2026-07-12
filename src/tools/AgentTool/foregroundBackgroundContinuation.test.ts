import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import {
  backgroundAgentTask,
  isLocalAgentTask,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { Message } from '../../types/message.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { AgentTool } from './AgentTool.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'

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

let toolUseYields = 0
let releaseForeground: (() => void) | undefined
const foregroundReachedTool = new Promise<void>(resolve => {
  releaseForeground = resolve
})
let releaseBackgroundContinuation: (() => void) | undefined
const backgroundMayFinish = new Promise<void>(resolve => {
  releaseBackgroundContinuation = resolve
})

mock.module('./runAgent.js', () => ({
  async *runAgent() {
    toolUseYields += 1
    yield makeAssistantMessage('tool', [
      {
        type: 'tool_use',
        id: `toolu_side_effect_${toolUseYields}`,
        name: 'Bash',
        input: { command: 'side-effect' },
      },
    ] as never)
    releaseForeground?.()
    await backgroundMayFinish
    yield makeAssistantMessage('done', [
      { type: 'text', text: 'done' },
    ] as never)
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

const context = createContext()
const callPromise = AgentTool.call(
  {
    description: 'background continuation',
    prompt: 'run one side effect then finish',
    subagent_type: 'general-purpose',
  },
  context,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_parent' } } as never,
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
releaseBackgroundContinuation?.()

for (let i = 0; i < 20; i++) {
  const task = context.getAppState().tasks[taskId]
  if (isLocalAgentTask(task) && task.status === 'completed') break
  await new Promise(resolve => setTimeout(resolve, 10))
}

const task = context.getAppState().tasks[taskId]
assert.ok(isLocalAgentTask(task))
assert.equal(task.status, 'completed')
assert.equal(toolUseYields, 1)
assert.equal(task.progress?.toolUseCount, 1)
assert.match(JSON.stringify(task.result), /done/)
assert.equal(task.result?.totalToolUseCount, 1)

console.log('foregroundBackgroundContinuation.test.ts passed')
