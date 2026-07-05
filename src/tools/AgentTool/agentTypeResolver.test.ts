import assert from 'node:assert/strict'

import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import { resolveAgentTypeForTesting } from './agentTypeResolver.js'

function agent(agentType: string): AgentDefinition {
  return {
    agentType,
    whenToUse: `Use ${agentType}`,
    source: 'projectSettings',
    baseDir: '/tmp/agents',
    getSystemPrompt: () => `You are ${agentType}`,
  }
}

const permissionContext = getEmptyToolPermissionContext()
const denyGeneralPurposeContext = {
  ...getEmptyToolPermissionContext(),
  alwaysDenyRules: {
    localSettings: ['Agent(general-purpose)'],
  },
}

assert.equal(
  resolveAgentTypeForTesting({
    requestedType: 'code-reviewer',
    activeAgents: [agent('code-reviewer')],
    allowedAgentTypes: undefined,
    permissionContext,
  }).agent.agentType,
  'code-reviewer',
)

assert.equal(
  resolveAgentTypeForTesting({
    requestedType: 'Code Reviewer',
    activeAgents: [agent('code-reviewer')],
    allowedAgentTypes: undefined,
    permissionContext,
  }).agent.agentType,
  'code-reviewer',
)

assert.equal(
  resolveAgentTypeForTesting({
    requestedType: 'code_reviewer',
    activeAgents: [agent('Code-Reviewer')],
    allowedAgentTypes: undefined,
    permissionContext,
  }).agent.agentType,
  'Code-Reviewer',
)

assert.throws(
  () =>
    resolveAgentTypeForTesting({
      requestedType: 'ab',
      activeAgents: [agent('a-b'), agent('a_b')],
      allowedAgentTypes: undefined,
      permissionContext,
    }),
  error =>
    error instanceof Error &&
    error.message.includes("Agent type 'ab' is ambiguous") &&
    error.message.includes('a-b') &&
    error.message.includes('a_b'),
)

assert.throws(
  () =>
    resolveAgentTypeForTesting({
      requestedType: 'plan',
      activeAgents: [agent('Plan')],
      allowedAgentTypes: ['Explore'],
      permissionContext,
    }),
  error =>
    error instanceof Error &&
    error.message.includes("Agent type 'plan' not found") &&
    error.message.includes('Explore'),
)

assert.throws(
  () =>
    resolveAgentTypeForTesting({
      requestedType: 'ab',
      activeAgents: [agent('a-b'), agent('a_b'), agent('other')],
      allowedAgentTypes: ['a-b'],
      permissionContext,
    }),
  error =>
    error instanceof Error &&
    error.message.includes("Agent type 'ab' is ambiguous") &&
    error.message.includes('a-b') &&
    error.message.includes('a_b (unavailable)') &&
    error.message.includes('Use the exact name: a-b'),
)

assert.throws(
  () =>
    resolveAgentTypeForTesting({
      requestedType: 'general purpose',
      activeAgents: [agent('general-purpose'), agent('code-reviewer')],
      allowedAgentTypes: undefined,
      permissionContext: denyGeneralPurposeContext,
    }),
  error =>
    error instanceof Error &&
    error.message.includes("Agent type 'general purpose' has been denied") &&
    error.message.includes('Agent(general-purpose)') &&
    error.message.includes('localSettings'),
)

assert.throws(
  () =>
    resolveAgentTypeForTesting({
      requestedType: 'missing-agent',
      activeAgents: [agent('general-purpose'), agent('code-reviewer')],
      allowedAgentTypes: undefined,
      permissionContext,
    }),
  error =>
    error instanceof Error &&
    error.message.includes("Agent type 'missing-agent' not found") &&
    error.message.includes('general-purpose') &&
    error.message.includes('code-reviewer'),
)

console.log('agentTypeResolver.test.ts passed')
