import assert from 'node:assert/strict'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import {
  buildAgentLaunchDebugParams,
  normalizeAgentDescription,
  shouldPreserveAgentToolUseResults,
} from './AgentTool.js'
import {
  applyRequestedAgentPermissionMode,
  shouldBubbleAgentPermissionPrompts,
} from './permissionMode.js'

assert.equal(
  normalizeAgentDescription('  Launch\n\tparams   should   normalize  '),
  'Launch params should normalize',
)
assert.equal(
  shouldPreserveAgentToolUseResults({ isNonInteractiveSession: false }),
  true,
)
assert.equal(
  shouldPreserveAgentToolUseResults({ isNonInteractiveSession: true }),
  false,
)

const params = buildAgentLaunchDebugParams({
  requestedType: 'general purpose',
  selectedAgentType: 'general-purpose',
  matchKind: 'normalized',
  description: 'Launch params should not leak',
  name: 'worker-name',
  model: 'claude-sonnet-4-6',
  permissionMode: 'acceptEdits',
  runInBackground: true,
  selectedAgentBackground: false,
  isAsync: true,
  isolation: 'worktree',
  cwd: '/tmp/agent-worktree',
  toolUseId: 'toolu_launch_params',
  requiredMcpServers: ['github'],
  availableMcpServers: ['github-enterprise'],
  childSubagentDepth: 2,
  availableToolNames: ['Read', 'Edit', 'mcp__github-enterprise__search'],
  agentDepth: 2,
  parentAgentId: 'agent-parent',
  spawnDepth: 2,
  agentSystemPromptChars: 123,
})

assert.equal(params.requestedType, 'general purpose')
assert.equal(params.selectedAgentType, 'general-purpose')
assert.equal(params.matchKind, 'normalized')
assert.equal(params.hasDescription, true)
assert.equal(params.descriptionLength, 'Launch params should not leak'.length)
assert.equal(params.hasName, true)
assert.equal(params.nameLength, 'worker-name'.length)
assert.equal(params.model, 'claude-sonnet-4-6')
assert.equal(params.permissionMode, 'acceptEdits')
assert.equal(params.runInBackground, true)
assert.equal(params.selectedAgentBackground, false)
assert.equal(params.isAsync, true)
assert.equal(params.isolation, 'worktree')
assert.equal(params.cwd, '/tmp/agent-worktree')
assert.equal(params.toolUseId, 'toolu_launch_params')
assert.deepEqual(params.requiredMcpServers, ['github'])
assert.deepEqual(params.availableMcpServers, ['github-enterprise'])
assert.equal(params.childSubagentDepth, 2)
assert.equal(params.agentDepth, 2)
assert.equal(params.parentAgentId, 'agent-parent')
assert.equal(params.spawnDepth, 2)
assert.equal(params.agentSystemPromptChars, 123)
assert.deepEqual(params.availableToolNames, [
  'Read',
  'Edit',
  'mcp__github-enterprise__search',
])

const serialized = JSON.stringify(params)
assert.equal(serialized.includes('Launch params should not leak'), false)
assert.equal(serialized.includes('worker-name'), false)

const requestedPlanContext = applyRequestedAgentPermissionMode(
  {
    ...getEmptyToolPermissionContext(),
    mode: 'bypassPermissions',
    isBypassPermissionsModeAvailable: true,
    prePlanMode: 'bypassPermissions',
    strippedDangerousRules: {
      userSettings: ['Bash(node:*)'],
    },
  },
  'plan',
)
assert.equal(requestedPlanContext.mode, 'plan')
assert.equal(requestedPlanContext.isBypassPermissionsModeAvailable, false)
assert.equal(requestedPlanContext.prePlanMode, undefined)
assert.equal(requestedPlanContext.strippedDangerousRules, undefined)

const cleanPlanContext = {
  ...getEmptyToolPermissionContext(),
  mode: 'plan' as const,
  isBypassPermissionsModeAvailable: false,
}
assert.equal(
  applyRequestedAgentPermissionMode(cleanPlanContext, 'plan'),
  cleanPlanContext,
)

const dontAskContext = {
  ...getEmptyToolPermissionContext(),
  mode: 'dontAsk' as const,
}
assert.equal(
  applyRequestedAgentPermissionMode(dontAskContext, 'plan').mode,
  'dontAsk',
)
assert.equal(
  applyRequestedAgentPermissionMode(dontAskContext, 'bubble').mode,
  'dontAsk',
)

const planContext = {
  ...getEmptyToolPermissionContext(),
  mode: 'plan' as const,
}
assert.equal(
  applyRequestedAgentPermissionMode(planContext, 'bubble').mode,
  'plan',
)

const defaultContext = {
  ...getEmptyToolPermissionContext(),
  mode: 'default' as const,
}
assert.equal(
  applyRequestedAgentPermissionMode(defaultContext, 'acceptEdits').mode,
  'default',
)
assert.equal(
  applyRequestedAgentPermissionMode(defaultContext, 'bypassPermissions').mode,
  'default',
)
assert.equal(
  applyRequestedAgentPermissionMode(defaultContext, 'dontAsk').mode,
  'dontAsk',
)

const acceptEditsContext = {
  ...getEmptyToolPermissionContext(),
  mode: 'acceptEdits' as const,
}
assert.equal(
  applyRequestedAgentPermissionMode(acceptEditsContext, 'default').mode,
  'default',
)
assert.equal(
  applyRequestedAgentPermissionMode(acceptEditsContext, 'bypassPermissions').mode,
  'acceptEdits',
)
assert.equal(
  applyRequestedAgentPermissionMode(acceptEditsContext, 'auto').mode,
  'acceptEdits',
)

const autoContext = {
  ...getEmptyToolPermissionContext(),
  mode: 'auto' as const,
}
assert.equal(
  applyRequestedAgentPermissionMode(autoContext, 'dontAsk').mode,
  'dontAsk',
)
assert.equal(
  applyRequestedAgentPermissionMode(autoContext, 'default').mode,
  'default',
)
assert.equal(
  applyRequestedAgentPermissionMode(autoContext, 'bubble').mode,
  'auto',
)

assert.equal(shouldBubbleAgentPermissionPrompts('bubble', 'auto'), true)
assert.equal(shouldBubbleAgentPermissionPrompts('bubble', 'default'), true)
assert.equal(shouldBubbleAgentPermissionPrompts('bubble', 'plan'), false)
assert.equal(shouldBubbleAgentPermissionPrompts('bubble', 'dontAsk'), false)
assert.equal(shouldBubbleAgentPermissionPrompts(undefined, 'default'), false)

console.log('agentLaunchParams.test.ts passed')
