import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import {
  AgentTool,
  buildAgentLaunchDebugParams,
} from './AgentTool.js'
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
  const state = {
    toolPermissionContext: getEmptyToolPermissionContext(),
    mcp: { clients: [], tools: [] },
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
    getAppState: () => state,
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
    worktreeBranch: 'agent-test',
    cwd: undefined,
    name: 'worker-name',
    toolUseId: 'toolu_metadata',
    spawnDepth: 2,
  }),
  {
    agentType: 'general-purpose',
    description: 'metadata test',
    worktreePath: '/tmp/worktree',
    worktreeBranch: 'agent-test',
    name: 'worker-name',
    toolUseId: 'toolu_metadata',
    spawnDepth: 2,
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

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const configDir = mkdtempSync(join(tmpdir(), 'agent-tool-stale-team-test-'))
process.env.CLAUDE_CONFIG_DIR = configDir
const staleTeamContext = createContext(1)
let staleTeamError: unknown
try {
  await AgentTool.call(
    {
      description: 'stale team context',
      prompt: 'reply ok',
      subagent_type: 'general-purpose',
      name: 'worker-name',
      isolation: 'worktree',
      cwd: '/tmp',
    },
    {
      ...staleTeamContext,
      getAppState: () => ({
        ...staleTeamContext.getAppState(),
        teamContext: { teamName: 'default' },
      }),
    } as never,
    async () => ({ behavior: 'allow' }),
    { message: { id: 'msg_stale_team' } } as never,
  )
} catch (error) {
  staleTeamError = error
}
assert.ok(staleTeamError instanceof Error)
assert.equal(
  staleTeamError.message,
  'cwd is mutually exclusive with isolation: "worktree"',
)

let explicitMissingTeamError: unknown
try {
  await AgentTool.call(
    {
      description: 'explicit missing team',
      prompt: 'reply ok',
      subagent_type: 'general-purpose',
      name: 'worker-name',
      team_name: 'default',
      isolation: 'worktree',
      cwd: '/tmp',
    },
    createContext(1) as never,
    async () => ({ behavior: 'allow' }),
    { message: { id: 'msg_explicit_missing_team' } } as never,
  )
} catch (error) {
  explicitMissingTeamError = error
}
assert.ok(explicitMissingTeamError instanceof Error)
assert.equal(
  explicitMissingTeamError.message,
  'cwd is mutually exclusive with isolation: "worktree"',
)

let explicitNonDefaultMissingTeamError: unknown
try {
  await AgentTool.call(
    {
      description: 'explicit non-default missing team',
      prompt: 'reply ok',
      subagent_type: 'general-purpose',
      name: 'worker-name',
      team_name: 'missing-team',
      isolation: 'worktree',
      cwd: '/tmp',
    },
    createContext(1) as never,
    async () => ({ behavior: 'allow' }),
    { message: { id: 'msg_explicit_non_default_missing_team' } } as never,
  )
} catch (error) {
  explicitNonDefaultMissingTeamError = error
}
assert.ok(explicitNonDefaultMissingTeamError instanceof Error)
assert.equal(
  explicitNonDefaultMissingTeamError.message,
  'cwd is mutually exclusive with isolation: "worktree"',
)

let explicitDefaultMissingTeamError: unknown
try {
  await AgentTool.call(
    {
      description: 'explicit default missing team',
      prompt: 'reply ok',
      subagent_type: 'definitely-missing-agent-type',
      name: 'worker-name',
      team_name: 'default',
    },
    createContext(1) as never,
    async () => ({ behavior: 'allow' }),
    { message: { id: 'msg_explicit_default_missing_team' } } as never,
  )
} catch (error) {
  explicitDefaultMissingTeamError = error
}
assert.ok(explicitDefaultMissingTeamError instanceof Error)
assert.equal(
  explicitDefaultMissingTeamError.message,
  "Agent type 'definitely-missing-agent-type' not found. Available agents: general-purpose",
)

let explicitTeamWithCwdError: unknown
try {
  await AgentTool.call(
    {
      description: 'explicit team with cwd',
      prompt: 'reply ok',
      subagent_type: 'definitely-missing-agent-type',
      name: 'worker-name',
      team_name: 'default',
      cwd: '/tmp',
    },
    createContext(1) as never,
    async () => ({ behavior: 'allow' }),
    { message: { id: 'msg_explicit_team_with_cwd' } } as never,
  )
} catch (error) {
  explicitTeamWithCwdError = error
}
assert.ok(explicitTeamWithCwdError instanceof Error)
assert.equal(
  explicitTeamWithCwdError.message,
  "Agent type 'definitely-missing-agent-type' not found. Available agents: general-purpose",
)

let emptyNameError: unknown
try {
  await AgentTool.call(
    {
      description: 'empty name',
      prompt: 'reply ok',
      subagent_type: 'general-purpose',
      name: '',
      team_name: 'default',
      isolation: 'worktree',
      cwd: '/tmp',
    },
    createContext(1) as never,
    async () => ({ behavior: 'allow' }),
    { message: { id: 'msg_empty_name' } } as never,
  )
} catch (error) {
  emptyNameError = error
}
assert.ok(emptyNameError instanceof Error)
assert.equal(
  emptyNameError.message,
  'cwd is mutually exclusive with isolation: "worktree"',
)
if (originalConfigDir === undefined) {
  delete process.env.CLAUDE_CONFIG_DIR
} else {
  process.env.CLAUDE_CONFIG_DIR = originalConfigDir
}
rmSync(configDir, { recursive: true, force: true })

const invalidContext = createContext(0)
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
    invalidContext as never,
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
assert.deepEqual(invalidContext.getAppState().tasks, {})
assert.equal(invalidContext.getAppState().agentNameRegistry.size, 0)

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

const debugParams = buildAgentLaunchDebugParams({
  requestedType: 'general purpose',
  selectedAgentType: 'general-purpose',
  matchKind: 'normalized',
  description: 'debug params test',
  model: 'claude-sonnet-4-6',
  permissionMode: undefined,
  runInBackground: true,
  selectedAgentBackground: false,
  isAsync: true,
  isolation: undefined,
  cwd: undefined,
  toolUseId: undefined,
  requiredMcpServers: [],
  availableMcpServers: ['github'],
  childSubagentDepth: 1,
  availableToolNames: ['Agent', 'Read'],
  agentDepth: 1,
  agentSystemPromptChars: 456,
})
assert.equal(debugParams.requestedType, 'general purpose')
assert.equal(debugParams.selectedAgentType, 'general-purpose')
assert.equal(debugParams.matchKind, 'normalized')
assert.equal(debugParams.hasDescription, true)
assert.equal(debugParams.descriptionLength, 'debug params test'.length)
assert.equal(debugParams.hasName, false)
assert.equal(debugParams.nameLength, undefined)
assert.equal(debugParams.runInBackground, true)
assert.equal(debugParams.isAsync, true)
assert.equal(debugParams.isolation, undefined)
assert.equal(debugParams.cwd, undefined)
assert.equal(debugParams.toolUseId, undefined)
assert.deepEqual(debugParams.requiredMcpServers, [])
assert.deepEqual(debugParams.availableMcpServers, ['github'])
assert.equal(debugParams.childSubagentDepth, 1)
assert.equal(debugParams.agentDepth, 1)
assert.equal(debugParams.agentSystemPromptChars, 456)
assert.deepEqual(debugParams.availableToolNames, ['Agent', 'Read'])
assert.equal(JSON.stringify(debugParams).includes('reply ready'), false)
assert.equal(JSON.stringify(debugParams).includes('debug params test'), false)

console.log('AgentTool.nesting.test.ts passed')
