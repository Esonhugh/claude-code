import assert from 'node:assert/strict'

import { getEmptyToolPermissionContext } from '../../Tool.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { AgentTool } from './AgentTool.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'
import {
  buildAgentMetadataForTesting,
  getAgentOptionsSubagentDepthForTesting,
  getRootSetAppStateForTesting,
} from './runAgent.js'
import { SUBAGENT_DEPTH_LIMIT_MESSAGE } from './subagentDepth.js'

type TestContext = {
  getAppState: () => {
    toolPermissionContext: ReturnType<typeof getEmptyToolPermissionContext>
    mcp: { clients: never[]; tools: never[] }
    tasks: Record<string, never>
    agentNameRegistry: Map<string, never>
  }
  setAppState: (updater: unknown) => void
  setAppStateForTasks?: (updater: (prev: ReturnType<TestContext['getAppState']>) => unknown) => void
}

function createContext(subagentDepth: number): TestContext {
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'claude-sonnet-4-6',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' as const },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: {
        activeAgents: [GENERAL_PURPOSE_AGENT],
        inactiveAgents: [],
        allowedAgentTypes: undefined,
      },
      subagentDepth,
    },
    messages: [],
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(10),
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
      mcp: { clients: [], tools: [] },
      tasks: {},
      agentNameRegistry: new Map(),
    }),
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as never as TestContext
}

let depthLimitError: unknown
try {
  await AgentTool.call(
    {
      description: 'too deep',
      prompt: 'do it',
      subagent_type: 'general-purpose',
    },
    createContext(5) as never,
    async () => ({ behavior: 'allow' }),
    { message: { id: 'msg_test' } } as never,
  )
} catch (error) {
  depthLimitError = error
}
assert.ok(depthLimitError instanceof Error)
assert.equal(depthLimitError.message, SUBAGENT_DEPTH_LIMIT_MESSAGE)

assert.deepEqual(
  buildAgentMetadataForTesting({
    agentType: 'general-purpose',
    description: 'metadata test',
    worktreePath: '/tmp/worktree',
    cwd: undefined,
  }),
  {
    agentType: 'general-purpose',
    description: 'metadata test',
    worktreePath: '/tmp/worktree',
  },
)

assert.deepEqual(
  buildAgentMetadataForTesting({
    agentType: 'general-purpose',
    description: 'metadata test',
    worktreePath: undefined,
    cwd: '/tmp/explicit-cwd',
  }),
  {
    agentType: 'general-purpose',
    description: 'metadata test',
    cwd: '/tmp/explicit-cwd',
  },
)

const depthContext = createContext(0) as never as { options: { subagentDepth?: number } }
depthContext.options.subagentDepth = 1
assert.equal(getAgentOptionsSubagentDepthForTesting(depthContext as never), 1)

let cwdWorktreeError: unknown
try {
  await AgentTool.call(
    {
      description: 'invalid cwd worktree',
      prompt: 'do it',
      subagent_type: 'general-purpose',
      isolation: 'worktree',
      cwd: '/tmp',
    },
    createContext(0) as never,
    async () => ({ behavior: 'allow' }),
    { message: { id: 'msg_cwd_worktree' } } as never,
  )
} catch (error) {
  cwdWorktreeError = error
}
assert.ok(cwdWorktreeError instanceof Error)
assert.equal(
  cwdWorktreeError.message,
  'cwd is mutually exclusive with isolation: "worktree"',
)

let rootSetCalls = 0
let isolatedSetCalls = 0
const rootSetter: NonNullable<TestContext['setAppStateForTasks']> = updater => {
  rootSetCalls += 1
  updater(createContext(1).getAppState())
}
const isolatedSetter = () => {
  isolatedSetCalls += 1
}
const contextWithRootSetter = {
  ...createContext(1),
  setAppState: isolatedSetter,
  setAppStateForTasks: rootSetter,
} as never

getRootSetAppStateForTesting(contextWithRootSetter as never)(state => state)
assert.equal(rootSetCalls, 1)
assert.equal(isolatedSetCalls, 0)

console.log('AgentTool.nesting.test.ts passed')
