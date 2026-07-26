import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { setSessionBypassPermissionsMode } from '../../bootstrap/state.js'
import { handlePlanApprovalResponse } from '../../utils/inProcessTeammateHelpers.js'
import { buildInheritedCliFlags } from '../../utils/swarm/spawnUtils.js'
import { spawnInProcessTeammate } from '../../utils/swarm/spawnInProcess.js'
import { setCliTeammateModeOverride } from '../../utils/swarm/backends/teammateModeSnapshot.js'
import type { InProcessRunnerConfig } from '../../utils/swarm/inProcessRunner.js'
import { writeTeamFileAsync } from '../../utils/swarm/teamHelpers.js'
import { GENERAL_PURPOSE_AGENT } from '../AgentTool/built-in/generalPurposeAgent.js'
import type { AgentDefinition } from '../AgentTool/loadAgentsDir.js'

const startedInProcessConfigs: InProcessRunnerConfig[] = []
let useInProcessBackend = true
let spawnedPaneCommand: string | undefined
mock.module('../../utils/swarm/inProcessRunner.js', () => ({
  startInProcessTeammate(config: InProcessRunnerConfig) {
    startedInProcessConfigs.push(config)
  },
}))
mock.module('../../utils/swarm/backends/registry.js', () => ({
  isInProcessEnabled: () => useInProcessBackend,
  detectAndGetBackend: async () => ({
    backend: { type: 'tmux' },
    needsIt2Setup: false,
  }),
  getBackendByType: () => ({ killPane: async () => {} }),
  markInProcessFallback: () => {},
  resetBackendDetection: () => {},
}))
mock.module('../../utils/swarm/teammateLayoutManager.js', () => ({
  assignTeammateColor: () => 'blue',
  createTeammatePaneInSwarmView: async () => ({
    paneId: '%test-pane',
    isFirstTeammate: false,
  }),
  enablePaneBorderStatus: async () => {},
  isInsideTmux: async () => false,
  sendCommandToPane: async (_paneId: string, command: string) => {
    spawnedPaneCommand = command
  },
}))

const { spawnTeammate } = await import('./spawnMultiAgent.js')

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const configDir = mkdtempSync(join(tmpdir(), 'spawn-multi-agent-test-'))
process.env.CLAUDE_CONFIG_DIR = configDir

setCliTeammateModeOverride('in-process')

let setAppStateCalls = 0
const context = {
  options: {
    agentDefinitions: {
      activeAgents: [GENERAL_PURPOSE_AGENT],
      inactiveAgents: [],
      allowedAgentTypes: undefined,
    },
  },
  toolUseId: 'toolu_spawn_test',
  getAppState: () => ({
    mainLoopModel: 'claude-sonnet-4-6',
    toolPermissionContext: getEmptyToolPermissionContext(),
    teamContext: { teamName: 'default' },
  }),
  setAppState: () => {
    setAppStateCalls += 1
  },
} as never

let missingTeamError: unknown
try {
  await spawnTeammate(
    {
      name: 'worker',
      prompt: 'do it',
    },
    context,
  )
} catch (error) {
  missingTeamError = error
}

assert.ok(missingTeamError instanceof Error)
assert.equal(
  missingTeamError.message,
  'Team "default" does not exist. Call spawnTeam first to create the team.',
)
assert.equal(setAppStateCalls, 0)

await writeTeamFileAsync('definition-team', {
  name: 'definition-team',
  createdAt: Date.now(),
  leadAgentId: 'team-lead@definition-team',
  members: [],
})

const specializedDefinitions: AgentDefinition[] = [
  {
    ...GENERAL_PURPOSE_AGENT,
    agentType: 'built-in-restricted-agent',
    tools: ['Read(example.txt)'],
    disallowedTools: ['Bash'],
  },
  {
    agentType: 'custom-restricted-agent',
    whenToUse: 'Test custom definition propagation',
    tools: ['Read(custom.txt)'],
    disallowedTools: ['Write'],
    source: 'projectSettings',
    getSystemPrompt: () => 'Custom restricted prompt',
  },
  {
    agentType: 'plugin-restricted-agent',
    whenToUse: 'Test plugin definition propagation',
    tools: ['Read(plugin.txt)'],
    disallowedTools: ['Edit'],
    source: 'plugin',
    plugin: 'test-plugin',
    getSystemPrompt: () => 'Plugin restricted prompt',
  },
]
let definitionState = {
  ...getDefaultAppState(),
  mainLoopModel: 'claude-sonnet-4-6' as const,
  toolPermissionContext: getEmptyToolPermissionContext(),
  teamContext: {
    teamName: 'definition-team',
    teamFilePath: '',
    leadAgentId: 'team-lead@definition-team',
    teammates: {},
  },
}
const definitionContext = {
  options: {
    tools: [],
    agentDefinitions: {
      activeAgents: specializedDefinitions,
      inactiveAgents: [],
      allowedAgentTypes: undefined,
    },
  },
  toolUseId: 'toolu_definition_spawn_test',
  getAppState: () => definitionState,
  setAppState: (updater: (prev: typeof definitionState) => typeof definitionState) => {
    definitionState = updater(definitionState)
  },
} as never

for (const definition of specializedDefinitions) {
  await spawnTeammate(
    {
      name: `${definition.agentType}-worker`,
      prompt: 'inspect only',
      team_name: 'definition-team',
      agent_type: definition.agentType,
      permissionMode: 'bypassPermissions',
      permissions: definition.tools,
      model: 'claude-sonnet-4-6',
    },
    definitionContext,
  )
  const startedConfig = startedInProcessConfigs.at(-1)
  assert.equal(startedConfig?.agentDefinition, definition)
  assert.deepEqual(startedConfig?.agentDefinition?.tools, definition.tools)
  assert.deepEqual(
    startedConfig?.agentDefinition?.disallowedTools,
    definition.disallowedTools,
  )
  assert.deepEqual(startedConfig?.allowedTools, definition.tools)
  if (definition.source === 'built-in') {
    assert.match(
      definition.getSystemPrompt({ toolUseContext: definitionContext }),
      /You are an agent for Claude Code/,
    )
  } else {
    assert.match(definition.getSystemPrompt(), /restricted prompt/i)
  }
  const spawnedTask = startedConfig
    ? definitionState.tasks[startedConfig.taskId]
    : undefined
  assert.equal(
    spawnedTask?.type === 'in_process_teammate'
      ? spawnedTask.permissionMode
      : undefined,
    'bypassPermissions',
  )
  startedConfig?.abortController.abort()
}
assert.equal(startedInProcessConfigs.length, specializedDefinitions.length)

useInProcessBackend = false
spawnedPaneCommand = undefined
await spawnTeammate(
  {
    name: 'process-restricted-worker',
    prompt: 'inspect only',
    team_name: 'definition-team',
    agent_type: 'custom-restricted-agent',
    permissionMode: 'default',
    permissions: ['Read(custom.txt)'],
    model: 'claude-sonnet-4-6',
  },
  definitionContext,
)
assert.ok(spawnedPaneCommand)
assert.match(spawnedPaneCommand, /--agent-type custom-restricted-agent(?:\s|$)/)
assert.match(spawnedPaneCommand, /--permission-mode default(?:\s|$)/)
assert.match(spawnedPaneCommand, /--allowedTools Read\\\(custom\.txt\\\)/)
useInProcessBackend = true

const extractPermissionFlags = (flags: string) =>
  flags
    .split(' ')
    .filter(Boolean)
    .filter(
      (flag, index, parts) =>
        flag === '--dangerously-skip-permissions' ||
        flag === '--permission-mode' ||
        parts[index - 1] === '--permission-mode',
    )

setSessionBypassPermissionsMode(false)
assert.deepEqual(
  extractPermissionFlags(
    buildInheritedCliFlags({ permissionMode: 'bypassPermissions' }),
  ),
  ['--dangerously-skip-permissions'],
)
for (const permissionMode of [
  'default',
  'acceptEdits',
  'dontAsk',
  'auto',
] as const) {
  assert.deepEqual(
    extractPermissionFlags(buildInheritedCliFlags({ permissionMode })),
    ['--permission-mode', permissionMode],
  )
}
assert.deepEqual(
  extractPermissionFlags(
    buildInheritedCliFlags({
      planModeRequired: true,
      permissionMode: 'bypassPermissions',
    }),
  ),
  ['--permission-mode', 'plan'],
)
assert.match(
  buildInheritedCliFlags({
    permissionMode: 'default',
    allowedTools: ['Read(example.txt)', 'Bash(npm test)'],
  }),
  /--allowedTools 'Read\(example\.txt\),Bash\(npm test\)'/,
)
assert.doesNotMatch(
  buildInheritedCliFlags({ permissionMode: 'default', allowedTools: [] }),
  /--allowedTools/,
)

setSessionBypassPermissionsMode(true)
try {
  assert.deepEqual(extractPermissionFlags(buildInheritedCliFlags()), [
    '--dangerously-skip-permissions',
  ])
  for (const permissionMode of [
    'default',
    'acceptEdits',
    'dontAsk',
  ] as const) {
    assert.deepEqual(
      extractPermissionFlags(buildInheritedCliFlags({ permissionMode })),
      ['--permission-mode', permissionMode],
    )
  }
} finally {
  setSessionBypassPermissionsMode(false)
}

for (const permissionMode of [
  'bypassPermissions',
  'acceptEdits',
  'default',
] as const) {
  let spawnedState = getDefaultAppState()
  const spawnResult = await spawnInProcessTeammate(
    {
      name: `${permissionMode}-worker`,
      teamName: 'permission-team',
      prompt: 'inspect only',
      planModeRequired: false,
      permissionMode,
    },
    {
      setAppState: updater => {
        spawnedState = updater(spawnedState)
      },
    },
  )
  assert.equal(spawnResult.success, true)
  const spawnedTask = spawnResult.taskId
    ? spawnedState.tasks[spawnResult.taskId]
    : undefined
  assert.equal(
    spawnedTask?.type === 'in_process_teammate'
      ? spawnedTask.permissionMode
      : undefined,
    permissionMode,
  )
  spawnResult.abortController?.abort()
}

let planSpawnState = getDefaultAppState()
const planSpawnResult = await spawnInProcessTeammate(
  {
    name: 'plan-worker',
    teamName: 'permission-team',
    prompt: 'inspect only',
    planModeRequired: true,
    permissionMode: 'bypassPermissions',
  },
  {
    setAppState: updater => {
      planSpawnState = updater(planSpawnState)
    },
  },
)
const planSpawnTask = planSpawnResult.taskId
  ? planSpawnState.tasks[planSpawnResult.taskId]
  : undefined
assert.equal(
  planSpawnTask?.type === 'in_process_teammate'
    ? planSpawnTask.permissionMode
    : undefined,
  'plan',
)
if (!planSpawnResult.taskId) {
  throw new Error('Expected plan teammate task ID')
}
handlePlanApprovalResponse(
  planSpawnResult.taskId,
  {
    type: 'plan_approval_response',
    requestId: 'plan-request',
    approved: true,
    timestamp: new Date().toISOString(),
    permissionMode: 'bypassPermissions',
  },
  updater => {
    planSpawnState = updater(planSpawnState)
  },
)
const approvedPlanTask = planSpawnState.tasks[planSpawnResult.taskId]
assert.equal(
  approvedPlanTask?.type === 'in_process_teammate'
    ? approvedPlanTask.permissionMode
    : undefined,
  'bypassPermissions',
)
assert.equal(
  approvedPlanTask?.type === 'in_process_teammate'
    ? approvedPlanTask.awaitingPlanApproval
    : undefined,
  false,
)
planSpawnResult.abortController?.abort()

if (originalConfigDir === undefined) {
  delete process.env.CLAUDE_CONFIG_DIR
} else {
  process.env.CLAUDE_CONFIG_DIR = originalConfigDir
}
rmSync(configDir, { recursive: true, force: true })

console.log('spawnMultiAgent.test.ts passed')
