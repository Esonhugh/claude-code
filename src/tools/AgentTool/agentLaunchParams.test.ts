import assert from 'node:assert/strict'
import {
  buildAgentLaunchDebugParams,
  normalizeAgentDescription,
  shouldPreserveAgentToolUseResults,
} from './AgentTool.js'

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

console.log('agentLaunchParams.test.ts passed')
