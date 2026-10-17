import assert from 'node:assert/strict'
import { afterAll } from 'bun:test'
import {
  getSessionSettingsCache,
  resetSettingsCache,
  setSessionSettingsCache,
} from '../../utils/settings/settingsCache.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import {
  buildAgentLaunchDebugParams,
  inputSchema,
  normalizeAgentDescription,
  shouldPreserveAgentToolUseResults,
} from './AgentTool.js'
import {
  applyRequestedAgentPermissionMode,
  resolveDeclaredAgentPermissionMode,
  shouldBubbleAgentPermissionPrompts,
} from './permissionMode.js'

const originalSettings = getSessionSettingsCache()
setSessionSettingsCache({ settings: { planModeAvailable: true }, errors: [] })
afterAll(() => {
  if (originalSettings) setSessionSettingsCache(originalSettings)
  else resetSettingsCache()
})

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

const agentToolJsonSchema = zodToJsonSchema(inputSchema()) as {
  required?: string[]
  properties?: {
    mode?: { description?: string }
  }
}
assert.deepEqual(agentToolJsonSchema.required, ['description', 'prompt'])
assert.match(
  agentToolJsonSchema.properties?.mode?.description ?? '',
  /Omit to inherit the caller mode/,
)
assert.match(
  agentToolJsonSchema.properties?.mode?.description ?? '',
  /bypassPermissions caller always remains bypassPermissions/,
)

for (const name of ['worker', 'Worker_2', 'a-b', '']) {
  assert.equal(inputSchema().safeParse({ description: 'd', prompt: 'p', name }).success, true, name)
}
// Resume only accepts names matching the official teammate-name rule, so spawn must refuse the rest.
for (const name of ['two words', 'a.b', '-lead', 'x'.repeat(65), 'main', 'Team-Lead', 'user', 'system', 'a0123456789abcdef']) {
  assert.equal(inputSchema().safeParse({ description: 'd', prompt: 'p', name }).success, false, name)
}

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

const bypassPlanContext = {
  ...getEmptyToolPermissionContext(),
  mode: 'bypassPermissions' as const,
  isBypassPermissionsModeAvailable: true,
  prePlanMode: 'bypassPermissions' as const,
  strippedDangerousRules: {
    userSettings: ['Bash(node:*)'],
  },
}
const requestedPlanContext = applyRequestedAgentPermissionMode(
  bypassPlanContext,
  'plan',
)
assert.equal(requestedPlanContext.mode, 'plan')
assert.equal(requestedPlanContext.isBypassPermissionsModeAvailable, true)
assert.equal(requestedPlanContext.prePlanMode, 'bypassPermissions')
assert.deepEqual(requestedPlanContext.strippedDangerousRules, {
  userSettings: ['Bash(node:*)'],
})

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
  'plan',
)
assert.equal(
  applyRequestedAgentPermissionMode(dontAskContext, 'bubble').mode,
  'bubble',
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
  'bubble',
)

// Official 2.1.292 derives prompt bubbling from the requested mode alone, so a
// bubble agent kept in its parent's plan/dontAsk mode still bubbles prompts.
assert.equal(shouldBubbleAgentPermissionPrompts('bubble'), true)
assert.equal(shouldBubbleAgentPermissionPrompts('plan'), false)
assert.equal(shouldBubbleAgentPermissionPrompts(undefined), false)

// Declared agent permissionMode, official 2.1.292 resolution.
const declaredModeMatrix = {
  default: { none: 'default', bubble: 'bubble', acceptEdits: 'acceptEdits', plan: 'plan', bypassPermissions: 'default' },
  plan: { none: 'plan', bubble: 'plan', acceptEdits: 'acceptEdits', plan: 'plan', bypassPermissions: 'plan' },
  dontAsk: { none: 'dontAsk', bubble: 'dontAsk', acceptEdits: 'acceptEdits', plan: 'plan', bypassPermissions: 'dontAsk' },
  acceptEdits: { none: 'acceptEdits', bubble: 'acceptEdits', acceptEdits: 'acceptEdits', plan: 'acceptEdits', bypassPermissions: 'acceptEdits' },
  auto: { none: 'auto', bubble: 'auto', acceptEdits: 'auto', plan: 'auto', bypassPermissions: 'auto' },
  bypassPermissions: { none: 'bypassPermissions', bubble: 'bypassPermissions', acceptEdits: 'bypassPermissions', plan: 'bypassPermissions', bypassPermissions: 'bypassPermissions' },
} as const
for (const [parentMode, row] of Object.entries(declaredModeMatrix)) {
  for (const [declared, expected] of Object.entries(row)) {
    assert.equal(
      resolveDeclaredAgentPermissionMode(
        parentMode as keyof typeof declaredModeMatrix,
        declared === 'none'
          ? undefined
          : (declared as Exclude<keyof typeof row, 'none'>),
      ),
      expected,
      `parent ${parentMode} declared ${declared}`,
    )
  }
}

console.log('agentLaunchParams.test.ts passed')
