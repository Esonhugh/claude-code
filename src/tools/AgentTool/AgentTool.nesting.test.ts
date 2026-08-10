import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { setMainLoopModelOverride } from '../../bootstrap/state.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { createAssistantMessage } from '../../utils/messages.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import {
  createTeammateContext,
  runWithTeammateContext,
} from '../../utils/teammateContext.js'
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
import { resolveAgentTools } from './agentToolUtils.js'
import { SUBAGENT_DEPTH_LIMIT_MESSAGE } from './subagentDepth.js'
import { createSyntheticOutputTool } from '../SyntheticOutputTool/SyntheticOutputTool.js'
import type { SpawnTeammateConfig } from '../shared/spawnMultiAgent.js'
import { writeTeamFileAsync } from '../../utils/swarm/teamHelpers.js'

const originalAgentTeamsFlag =
  process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'

function createTestAssistantMessage(text: string) {
  return createAssistantMessage({ content: text })
}

async function* createControlledAgentStream() {
  yield createTestAssistantMessage('controlled agent done')
}

let controlledAvailableToolNames: string[] = []
let controlledResolvedToolNames: string[] = []
let controlledPermissionMode: Parameters<typeof resolveAgentTools>[0]['permissionMode']
let controlledAllowedTools: string[] | undefined
let controlledCanShowPermissionPrompts: boolean | undefined
let controlledMainLoopModel: string | undefined
let controlledSpawnTeammateConfig: SpawnTeammateConfig | undefined
mock.module('../shared/spawnMultiAgent.js', () => ({
  spawnTeammate: async (config: SpawnTeammateConfig) => {
    controlledSpawnTeammateConfig = config
    return {
      data: {
        teammate_id: `${config.name}@${config.team_name}`,
        agent_id: `${config.name}@${config.team_name}`,
        name: config.name,
        tmux_session_name: 'test',
        tmux_window_name: 'test',
        tmux_pane_id: 'test',
      },
    }
  },
}))
mock.module('./runAgent.js', () => ({
  runAgent: (params: {
    agentDefinition: Parameters<typeof resolveAgentTools>[0]
    availableTools: Parameters<typeof resolveAgentTools>[1]
    isAsync: boolean
    canShowPermissionPrompts?: boolean
    permissionMode?: Parameters<typeof resolveAgentTools>[0]['permissionMode']
    allowedTools?: string[]
    toolUseContext: { options: { mainLoopModel: string } }
  }) => {
    controlledAvailableToolNames = params.availableTools.map(tool => tool.name)
    controlledResolvedToolNames = resolveAgentTools(
      {
        ...params.agentDefinition,
        permissionMode: params.permissionMode,
      },
      params.availableTools,
      params.isAsync,
    ).resolvedTools.map(tool => tool.name)
    controlledPermissionMode = params.permissionMode
    controlledAllowedTools = params.allowedTools
    controlledCanShowPermissionPrompts = params.canShowPermissionPrompts
    controlledMainLoopModel = params.toolUseContext.options.mainLoopModel
    return createControlledAgentStream()
  },
}))

type TestContext = {
  getAppState: () => ReturnType<typeof getDefaultAppState>
  setAppState: (updater: unknown) => void
  setAppStateForTasks?: (updater: (prev: ReturnType<TestContext['getAppState']>) => unknown) => void
  waitForTaskLifecycle: (taskId: string) => Promise<void>
}

function createContext(subagentDepth: number): TestContext {
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
  const taskLifecycleWaiters = new Map<string, () => void>()
  const isTaskLifecycleComplete = (taskId: string) => {
    const task = state.tasks[taskId]
    return (
      task?.notified &&
      task.status !== 'running' &&
      state.speculation.status === 'idle'
    )
  }
  const resolveTaskLifecycleWaiters = () => {
    for (const [taskId, resolve] of taskLifecycleWaiters) {
      if (isTaskLifecycleComplete(taskId)) {
        taskLifecycleWaiters.delete(taskId)
        resolve()
      }
    }
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
    setAppState: updater => {
      state = typeof updater === 'function' ? updater(state) : updater
      resolveTaskLifecycleWaiters()
    },
    waitForTaskLifecycle: taskId => {
      if (isTaskLifecycleComplete(taskId)) {
        return Promise.resolve()
      }
      return new Promise<void>(resolve => {
        taskLifecycleWaiters.set(taskId, resolve)
      })
    },
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
    permissionMode: 'plan',
    parentAgentId: 'agent-parent',
    spawnDepth: 2,
  }),
  {
    agentType: 'general-purpose',
    description: 'metadata test',
    worktreePath: '/tmp/worktree',
    worktreeBranch: 'agent-test',
    name: 'worker-name',
    toolUseId: 'toolu_metadata',
    permissionMode: 'plan',
    parentAgentId: 'agent-parent',
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

const structuredOutputResult = createSyntheticOutputTool({
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: { ok: { type: 'boolean' } },
})
if (!('tool' in structuredOutputResult)) {
  throw new Error(structuredOutputResult.error)
}
const structuredOutputContext = createContext(0) as never as {
  options: { tools: Array<{ name: string }> }
}
structuredOutputContext.options.tools = [structuredOutputResult.tool]
controlledAvailableToolNames = []
await AgentTool.call(
  {
    description: 'structured output worker',
    prompt: 'return structured output',
    subagent_type: 'general-purpose',
  },
  structuredOutputContext as never,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_structured_output_worker' } } as never,
)
assert.ok(controlledAvailableToolNames.includes('StructuredOutput'))
assert.ok(controlledResolvedToolNames.includes('StructuredOutput'))

controlledPermissionMode = undefined
controlledMainLoopModel = undefined
const planModeContext = createContext(0) as never as TestContext & {
  options: { mainLoopModel: string }
}
planModeContext.options.mainLoopModel = 'claude-opus-4-6[1m]'
setMainLoopModelOverride('opusplan')
try {
  await AgentTool.call(
    {
      description: 'plan mode worker',
      prompt: 'inspect only',
      subagent_type: 'general-purpose',
      mode: 'plan',
    },
    planModeContext as never,
    async () => ({ behavior: 'allow' }),
    { message: { id: 'msg_plan_mode_worker' } } as never,
  )
} finally {
  setMainLoopModelOverride(undefined)
}
assert.equal(controlledPermissionMode, 'plan')
assert.ok(controlledResolvedToolNames.includes('ExitPlanMode'))
assert.doesNotMatch(controlledMainLoopModel ?? '', /\[1m\]/)

controlledPermissionMode = undefined
const inheritedPlanModeContext = createContext(0) as never as TestContext
inheritedPlanModeContext.setAppState((prev: ReturnType<TestContext['getAppState']>) => ({
  ...prev,
  toolPermissionContext: {
    ...prev.toolPermissionContext,
    mode: 'plan',
  },
}))
await AgentTool.call(
  {
    description: 'inherited plan mode worker',
    prompt: 'inspect only',
    subagent_type: 'general-purpose',
  },
  inheritedPlanModeContext as never,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_inherited_plan_mode_worker' } } as never,
)
assert.equal(controlledPermissionMode, 'plan')
assert.ok(controlledResolvedToolNames.includes('ExitPlanMode'))

for (const inheritedMode of ['acceptEdits', 'bypassPermissions'] as const) {
  controlledPermissionMode = undefined
  const inheritedModeContext = createContext(0) as never as TestContext
  inheritedModeContext.setAppState(
    (prev: ReturnType<TestContext['getAppState']>) => ({
      ...prev,
      toolPermissionContext: {
        ...prev.toolPermissionContext,
        mode: inheritedMode,
      },
    }),
  )
  await AgentTool.call(
    {
      description: `inherited ${inheritedMode} worker`,
      prompt: 'inspect only',
      subagent_type: 'general-purpose',
    },
    inheritedModeContext as never,
    async () => ({ behavior: 'allow' }),
    { message: { id: `msg_inherited_${inheritedMode}_worker` } } as never,
  )
  assert.equal(controlledPermissionMode, inheritedMode)
}

const bypassParentContext = createContext(0) as never as TestContext
bypassParentContext.setAppState(
  (prev: ReturnType<TestContext['getAppState']>) => ({
    ...prev,
    toolPermissionContext: {
      ...prev.toolPermissionContext,
      mode: 'bypassPermissions',
    },
  }),
)
for (const generatedMode of [
  'default',
  'acceptEdits',
  'dontAsk',
  'plan',
] as const) {
  controlledPermissionMode = undefined
  await AgentTool.call(
    {
      description: `bypass parent with generated ${generatedMode} worker`,
      prompt: 'inspect only',
      subagent_type: 'general-purpose',
      mode: generatedMode,
    },
    bypassParentContext as never,
    async () => ({ behavior: 'allow' }),
    { message: { id: `msg_bypass_parent_generated_${generatedMode}_worker` } } as never,
  )
  assert.equal(controlledPermissionMode, 'bypassPermissions')
}

controlledPermissionMode = undefined
const blockedEscalationContext = createContext(0) as never as TestContext
await AgentTool.call(
  {
    description: 'blocked permission escalation worker',
    prompt: 'inspect only',
    subagent_type: 'general-purpose',
    mode: 'bypassPermissions',
  },
  blockedEscalationContext as never,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_blocked_permission_escalation_worker' } } as never,
)
assert.equal(controlledPermissionMode, 'default')

const bypassDefinitionAgent = {
  ...GENERAL_PURPOSE_AGENT,
  agentType: 'bypass-definition-agent',
  permissionMode: 'bypassPermissions' as const,
}
const bypassDefinitionContext = createContext(0) as never as TestContext & {
  options: {
    agentDefinitions: {
      activeAgents: typeof bypassDefinitionAgent[]
      inactiveAgents: []
      allowedAgentTypes: undefined
    }
  }
}
bypassDefinitionContext.options.agentDefinitions = {
  activeAgents: [bypassDefinitionAgent],
  inactiveAgents: [],
  allowedAgentTypes: undefined,
}
bypassDefinitionContext.setAppState(
  (prev: ReturnType<TestContext['getAppState']>) => ({
    ...prev,
    agentDefinitions: bypassDefinitionContext.options.agentDefinitions,
  }),
)
controlledPermissionMode = undefined
await AgentTool.call(
  {
    description: 'trusted definition elevation worker',
    prompt: 'inspect only',
    subagent_type: 'bypass-definition-agent',
  },
  bypassDefinitionContext as never,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_trusted_definition_elevation_worker' } } as never,
)
assert.equal(controlledPermissionMode, 'bypassPermissions')

controlledPermissionMode = undefined
await AgentTool.call(
  {
    description: 'definition elevation after blocked request worker',
    prompt: 'inspect only',
    subagent_type: 'bypass-definition-agent',
    mode: 'bypassPermissions',
  },
  bypassDefinitionContext as never,
  async () => ({ behavior: 'allow' }),
  {
    message: { id: 'msg_definition_elevation_after_blocked_request_worker' },
  } as never,
)
assert.equal(controlledPermissionMode, 'bypassPermissions')

const explicitDefaultDefinitionContext =
  createContext(0) as never as TestContext & {
    options: typeof bypassDefinitionContext.options
  }
explicitDefaultDefinitionContext.options.agentDefinitions =
  bypassDefinitionContext.options.agentDefinitions
explicitDefaultDefinitionContext.setAppState(
  (prev: ReturnType<TestContext['getAppState']>) => ({
    ...prev,
    toolPermissionContext: {
      ...prev.toolPermissionContext,
      mode: 'bypassPermissions',
    },
    agentDefinitions: explicitDefaultDefinitionContext.options.agentDefinitions,
  }),
)
controlledPermissionMode = undefined
await AgentTool.call(
  {
    description: 'generated default cannot override bypass parent worker',
    prompt: 'inspect only',
    subagent_type: 'bypass-definition-agent',
    mode: 'default',
  },
  explicitDefaultDefinitionContext as never,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_generated_default_cannot_override_bypass_parent_worker' } } as never,
)
assert.equal(controlledPermissionMode, 'bypassPermissions')

const explicitDefaultNonBypassContext =
  createContext(0) as never as TestContext & {
    options: typeof bypassDefinitionContext.options
  }
explicitDefaultNonBypassContext.options.agentDefinitions =
  bypassDefinitionContext.options.agentDefinitions
explicitDefaultNonBypassContext.setAppState(
  (prev: ReturnType<TestContext['getAppState']>) => ({
    ...prev,
    toolPermissionContext: {
      ...prev.toolPermissionContext,
      mode: 'acceptEdits',
    },
    agentDefinitions: explicitDefaultNonBypassContext.options.agentDefinitions,
  }),
)
controlledPermissionMode = undefined
await AgentTool.call(
  {
    description: 'explicit default overrides definition worker',
    prompt: 'inspect only',
    subagent_type: 'bypass-definition-agent',
    mode: 'default',
  },
  explicitDefaultNonBypassContext as never,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_explicit_default_overrides_definition_worker' } } as never,
)
assert.equal(controlledPermissionMode, 'default')

const bubbleAgent = {
  ...GENERAL_PURPOSE_AGENT,
  agentType: 'bubble-agent',
  permissionMode: 'bubble' as const,
}
const autoBubbleContext = createContext(0) as never as TestContext & {
  options: {
    agentDefinitions: {
      activeAgents: typeof bubbleAgent[]
      inactiveAgents: []
      allowedAgentTypes: undefined
    }
  }
}
autoBubbleContext.options.agentDefinitions = {
  activeAgents: [bubbleAgent],
  inactiveAgents: [],
  allowedAgentTypes: undefined,
}
autoBubbleContext.setAppState((prev: ReturnType<TestContext['getAppState']>) => ({
  ...prev,
  toolPermissionContext: {
    ...prev.toolPermissionContext,
    mode: 'auto',
  },
  agentDefinitions: autoBubbleContext.options.agentDefinitions,
}))
controlledPermissionMode = undefined
controlledCanShowPermissionPrompts = undefined
await AgentTool.call(
  {
    description: 'bubble prompt worker',
    prompt: 'inspect only',
    subagent_type: 'bubble-agent',
  },
  autoBubbleContext as never,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_bubble_prompt_worker' } } as never,
)
assert.equal(controlledPermissionMode, 'bubble')
assert.equal(controlledCanShowPermissionPrompts, true)

for (const parentMode of ['plan', 'dontAsk'] as const) {
  const restrictedBubbleContext = createContext(0) as never as TestContext & {
    options: typeof autoBubbleContext.options
  }
  restrictedBubbleContext.options.agentDefinitions =
    autoBubbleContext.options.agentDefinitions
  restrictedBubbleContext.setAppState(
    (prev: ReturnType<TestContext['getAppState']>) => ({
      ...prev,
      toolPermissionContext: {
        ...prev.toolPermissionContext,
        mode: parentMode,
      },
      agentDefinitions: restrictedBubbleContext.options.agentDefinitions,
    }),
  )
  controlledPermissionMode = undefined
  controlledCanShowPermissionPrompts = undefined
  await AgentTool.call(
    {
      description: `${parentMode} bubble prompt worker`,
      prompt: 'inspect only',
      subagent_type: 'bubble-agent',
    },
    restrictedBubbleContext as never,
    async () => ({ behavior: 'allow' }),
    { message: { id: `msg_${parentMode}_bubble_prompt_worker` } } as never,
  )
  assert.equal(controlledPermissionMode, 'bubble')
  assert.equal(controlledCanShowPermissionPrompts, true)
}

const restrictedAgent = {
  ...GENERAL_PURPOSE_AGENT,
  agentType: 'restricted-structured-output',
  tools: ['Read(example.txt)'],
  permissionMode: 'default' as const,
}
const restrictedStructuredOutputContext = createContext(0) as never as TestContext & {
  options: {
    tools: Array<{ name: string }>
    agentDefinitions: {
      activeAgents: typeof restrictedAgent[]
      inactiveAgents: []
      allowedAgentTypes: undefined
    }
  }
}
restrictedStructuredOutputContext.options.tools = [structuredOutputResult.tool]
restrictedStructuredOutputContext.options.agentDefinitions = {
  activeAgents: [restrictedAgent],
  inactiveAgents: [],
  allowedAgentTypes: undefined,
}
restrictedStructuredOutputContext.setAppState((prev: ReturnType<TestContext['getAppState']>) => ({
  ...prev,
  toolPermissionContext: {
    ...prev.toolPermissionContext,
    mode: 'bypassPermissions',
  },
  agentDefinitions: restrictedStructuredOutputContext.options.agentDefinitions,
}))
controlledAvailableToolNames = []
controlledResolvedToolNames = []
controlledAllowedTools = undefined
await AgentTool.call(
  {
    description: 'restricted structured output worker',
    prompt: 'return structured output',
    subagent_type: 'restricted-structured-output',
  },
  restrictedStructuredOutputContext as never,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_restricted_structured_output_worker' } } as never,
)
assert.equal(controlledPermissionMode, 'bypassPermissions')
assert.ok(controlledAvailableToolNames.includes('StructuredOutput'))
assert.ok(controlledResolvedToolNames.includes('Read'))
assert.ok(controlledResolvedToolNames.includes('StructuredOutput'))
assert.deepEqual(controlledAllowedTools, ['Read(example.txt)'])

const originalNamedConfigDir = process.env.CLAUDE_CONFIG_DIR
const namedConfigDir = mkdtempSync(join(tmpdir(), 'agent-tool-named-test-'))
process.env.CLAUDE_CONFIG_DIR = namedConfigDir
try {
  await writeTeamFileAsync('named-team', {
    name: 'named-team',
    createdAt: Date.now(),
    leadAgentId: 'team-lead@named-team',
    members: [],
  })

  const namedRestrictedAgent = {
    ...GENERAL_PURPOSE_AGENT,
    agentType: 'named-restricted-agent',
    tools: ['Read(example.txt)', 'MissingTool', 'Bash(npm test)'],
    disallowedTools: ['Bash'],
    permissionMode: 'default' as const,
  }
  const namedRestrictedContext = createContext(0) as never as TestContext & {
    options: {
      tools: Array<{ name: string }>
      agentDefinitions: {
        activeAgents: typeof namedRestrictedAgent[]
        inactiveAgents: []
        allowedAgentTypes: undefined
      }
    }
  }
  namedRestrictedContext.options.tools = []
  namedRestrictedContext.options.agentDefinitions = {
    activeAgents: [namedRestrictedAgent],
    inactiveAgents: [],
    allowedAgentTypes: undefined,
  }
  namedRestrictedContext.setAppState(
    (prev: ReturnType<TestContext['getAppState']>) => ({
      ...prev,
      toolPermissionContext: {
        ...prev.toolPermissionContext,
        mode: 'bypassPermissions',
      },
      agentDefinitions: namedRestrictedContext.options.agentDefinitions,
      teamContext: {
        teamName: 'named-team',
        teamFilePath: '',
        leadAgentId: 'team-lead@named-team',
        teammates: {},
      },
    }),
  )
  controlledSpawnTeammateConfig = undefined
  await AgentTool.call(
    {
      description: 'named restricted teammate',
      prompt: 'inspect only',
      subagent_type: 'named-restricted-agent',
      name: 'named-worker',
    },
    namedRestrictedContext as never,
    async () => ({ behavior: 'allow' }),
    { message: { id: 'msg_named_restricted_teammate' } } as never,
  )
  assert.equal(
    controlledSpawnTeammateConfig?.permissionMode,
    'bypassPermissions',
  )
  assert.deepEqual(
    controlledSpawnTeammateConfig?.permissions,
    ['Read(example.txt)'],
  )

  const emptyToolsAgent = {
    ...GENERAL_PURPOSE_AGENT,
    agentType: 'named-empty-tools-agent',
    tools: [],
  }
  const emptyToolsNamedContext = createContext(0) as never as TestContext & {
    options: {
      agentDefinitions: {
        activeAgents: typeof emptyToolsAgent[]
        inactiveAgents: []
        allowedAgentTypes: undefined
      }
    }
  }
  emptyToolsNamedContext.options.agentDefinitions = {
    activeAgents: [emptyToolsAgent],
    inactiveAgents: [],
    allowedAgentTypes: undefined,
  }
  emptyToolsNamedContext.setAppState(
    (prev: ReturnType<TestContext['getAppState']>) => ({
      ...prev,
      agentDefinitions: emptyToolsNamedContext.options.agentDefinitions,
      teamContext: {
        teamName: 'named-team',
        teamFilePath: '',
        leadAgentId: 'team-lead@named-team',
        teammates: {},
      },
    }),
  )
  controlledSpawnTeammateConfig = undefined
  await AgentTool.call(
    {
      description: 'named empty tools teammate',
      prompt: 'inspect only',
      subagent_type: 'named-empty-tools-agent',
      name: 'empty-tools-worker',
    },
    emptyToolsNamedContext as never,
    async () => ({ behavior: 'allow' }),
    { message: { id: 'msg_named_empty_tools_teammate' } } as never,
  )
  assert.deepEqual(controlledSpawnTeammateConfig?.permissions, [])

  const inheritedNamedContext = createContext(0) as never as TestContext
  inheritedNamedContext.setAppState(
    (prev: ReturnType<TestContext['getAppState']>) => ({
      ...prev,
      toolPermissionContext: {
        ...prev.toolPermissionContext,
        mode: 'bypassPermissions',
      },
      teamContext: {
        teamName: 'named-team',
        teamFilePath: '',
        leadAgentId: 'team-lead@named-team',
        teammates: {},
      },
    }),
  )
  controlledSpawnTeammateConfig = undefined
  await AgentTool.call(
    {
      description: 'named inherited teammate',
      prompt: 'inspect only',
      subagent_type: 'general-purpose',
      name: 'inherited-worker',
    },
    inheritedNamedContext as never,
    async () => ({ behavior: 'allow' }),
    { message: { id: 'msg_named_inherited_teammate' } } as never,
  )
  assert.equal(
    controlledSpawnTeammateConfig?.permissionMode,
    'bypassPermissions',
  )
} finally {
  if (originalNamedConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalNamedConfigDir
  }
  rmSync(namedConfigDir, { recursive: true, force: true })
}

const spawnDepthOnlyContext = createContext(0) as never as TestContext & {
  agentId: string
  options: { subagentDepth?: number; spawnDepth?: number }
}
spawnDepthOnlyContext.agentId = 'agent-parent'
delete spawnDepthOnlyContext.options.subagentDepth
spawnDepthOnlyContext.options.spawnDepth = 1
const spawnDepthOnlyResult = await AgentTool.call(
  {
    description: 'spawn depth only',
    prompt: 'reply ok',
    subagent_type: 'general-purpose',
    run_in_background: true,
  },
  spawnDepthOnlyContext as never,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_spawn_depth_only' } } as never,
)
assert.equal(spawnDepthOnlyResult.data.status, 'async_launched')
const spawnDepthOnlyTask = spawnDepthOnlyContext.getAppState().tasks[
  spawnDepthOnlyResult.data.agentId
] as LocalAgentTaskState | undefined
assert.equal(spawnDepthOnlyTask?.parentAgentId, 'agent-parent')
spawnDepthOnlyTask?.abortController?.abort()
await spawnDepthOnlyContext.waitForTaskLifecycle(spawnDepthOnlyResult.data.agentId)

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

const teammateContext = createTeammateContext({
  agentId: 'worker@default',
  agentName: 'worker',
  teamName: 'default',
  planModeRequired: false,
  parentSessionId: 'session_test',
  abortController: new AbortController(),
})

let teammateBackgroundError: unknown
try {
  await runWithTeammateContext(teammateContext, () =>
    AgentTool.call(
      {
        description: 'teammate background',
        prompt: 'reply ok',
        subagent_type: 'general-purpose',
        run_in_background: true,
      },
      createContext(1) as never,
      async () => ({ behavior: 'allow' }),
      { message: { id: 'msg_teammate_background' } } as never,
    ),
  )
} catch (error) {
  teammateBackgroundError = error
}
assert.ok(teammateBackgroundError instanceof Error)
assert.equal(
  teammateBackgroundError.message,
  'In-process teammates cannot spawn background agents. Use run_in_background=false for synchronous subagents.',
)

const backgroundAgent = {
  ...GENERAL_PURPOSE_AGENT,
  agentType: 'background-agent',
  background: true,
}
const backgroundBaseContext = createContext(1) as never as {
  options: Record<string, unknown>
}
const backgroundAgentContext = {
  ...backgroundBaseContext,
  options: {
    ...backgroundBaseContext.options,
    agentDefinitions: {
      activeAgents: [GENERAL_PURPOSE_AGENT, backgroundAgent],
      inactiveAgents: [],
      allowedAgentTypes: undefined,
    },
  },
} as never

let teammateBackgroundAgentError: unknown
try {
  await runWithTeammateContext(teammateContext, () =>
    AgentTool.call(
      {
        description: 'teammate background agent',
        prompt: 'reply ok',
        subagent_type: 'background-agent',
      },
      backgroundAgentContext,
      async () => ({ behavior: 'allow' }),
      { message: { id: 'msg_teammate_background_agent' } } as never,
    ),
  )
} catch (error) {
  teammateBackgroundAgentError = error
}
assert.ok(teammateBackgroundAgentError instanceof Error)
assert.equal(
  teammateBackgroundAgentError.message,
  "In-process teammates cannot spawn background agents. Agent 'background-agent' has background: true in its definition.",
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
  parentAgentId: 'agent-parent',
  spawnDepth: 1,
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
assert.equal(debugParams.parentAgentId, 'agent-parent')
assert.equal(debugParams.spawnDepth, 1)
assert.equal(debugParams.agentSystemPromptChars, 456)
assert.deepEqual(debugParams.availableToolNames, ['Agent', 'Read'])
assert.equal(JSON.stringify(debugParams).includes('reply ready'), false)
assert.equal(JSON.stringify(debugParams).includes('debug params test'), false)

if (originalAgentTeamsFlag === undefined) {
  delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
} else {
  process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = originalAgentTeamsFlag
}

console.log('AgentTool.nesting.test.ts passed')
