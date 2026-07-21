import { afterEach, describe, expect, test } from 'bun:test'

import {
  areExplorePlanAgentsEnabled,
  getBuiltInAgents,
} from './builtInAgents.js'

const originalDisableExplorePlanAgents =
  process.env.CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS

afterEach(() => {
  if (originalDisableExplorePlanAgents === undefined) {
    delete process.env.CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS
  } else {
    process.env.CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS =
      originalDisableExplorePlanAgents
  }
})

describe('Explore and Plan built-in agents', () => {
  test('are enabled by default', () => {
    delete process.env.CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS

    expect(areExplorePlanAgentsEnabled()).toBe(true)
    expect(getBuiltInAgents().some(agent => agent.agentType === 'Explore')).toBe(
      true,
    )
    expect(getBuiltInAgents().some(agent => agent.agentType === 'Plan')).toBe(
      true,
    )
  })

  test('can be disabled by environment variable', () => {
    process.env.CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS = '1'

    expect(areExplorePlanAgentsEnabled()).toBe(false)
    expect(getBuiltInAgents().some(agent => agent.agentType === 'Explore')).toBe(
      false,
    )
    expect(getBuiltInAgents().some(agent => agent.agentType === 'Plan')).toBe(
      false,
    )
  })
})
