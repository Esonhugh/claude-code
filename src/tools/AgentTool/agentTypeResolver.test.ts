import { describe, expect, test } from 'bun:test'

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

describe('agent type resolution', () => {
  test('resolves an exact Explore agent type', () => {
    const resolution = resolveAgentTypeForTesting({
      requestedType: 'Explore',
      activeAgents: [agent('Explore'), agent('Plan')],
      allowedAgentTypes: undefined,
      permissionContext,
    })

    expect(resolution.agent.agentType).toBe('Explore')
    expect(resolution.matchKind).toBe('exact')
  })

  test('resolves normalized whitespace and punctuation', () => {
    expect(
      resolveAgentTypeForTesting({
        requestedType: 'Code Reviewer',
        activeAgents: [agent('code-reviewer')],
        allowedAgentTypes: undefined,
        permissionContext,
      }).agent.agentType,
    ).toBe('code-reviewer')

    expect(
      resolveAgentTypeForTesting({
        requestedType: 'code_reviewer',
        activeAgents: [agent('Code-Reviewer')],
        allowedAgentTypes: undefined,
        permissionContext,
      }).agent.agentType,
    ).toBe('Code-Reviewer')
  })

  test('rejects ambiguous normalized matches', () => {
    expect(() =>
      resolveAgentTypeForTesting({
        requestedType: 'ab',
        activeAgents: [agent('a-b'), agent('a_b')],
        allowedAgentTypes: undefined,
        permissionContext,
      }),
    ).toThrow("Agent type 'ab' is ambiguous")
  })

  test('rejects agents outside the allowed scope', () => {
    expect(() =>
      resolveAgentTypeForTesting({
        requestedType: 'plan',
        activeAgents: [agent('Plan')],
        allowedAgentTypes: ['Explore'],
        permissionContext,
      }),
    ).toThrow("Agent type 'plan' not found")
  })

  test('reports unavailable normalized collisions', () => {
    expect(() =>
      resolveAgentTypeForTesting({
        requestedType: 'ab',
        activeAgents: [agent('a-b'), agent('a_b'), agent('other')],
        allowedAgentTypes: ['a-b'],
        permissionContext,
      }),
    ).toThrow('a_b (unavailable)')
  })

  test('reports permission-denied agents', () => {
    expect(() =>
      resolveAgentTypeForTesting({
        requestedType: 'general purpose',
        activeAgents: [agent('general-purpose'), agent('code-reviewer')],
        allowedAgentTypes: undefined,
        permissionContext: denyGeneralPurposeContext,
      }),
    ).toThrow("Agent type 'general purpose' has been denied")
  })

  test('reports missing agents and available alternatives', () => {
    expect(() =>
      resolveAgentTypeForTesting({
        requestedType: 'missing-agent',
        activeAgents: [agent('general-purpose'), agent('code-reviewer')],
        allowedAgentTypes: undefined,
        permissionContext,
      }),
    ).toThrow(
      "Agent type 'missing-agent' not found. Available agents: general-purpose, code-reviewer",
    )
  })
})
