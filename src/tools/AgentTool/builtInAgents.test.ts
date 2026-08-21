import { afterEach, describe, expect, test } from 'bun:test'

import { getCoordinatorAgents, getWorkerSystemPrompt } from '../../coordinator/workerAgent.js'
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

  test('keep compact read-only prompts', () => {
    const agents = getBuiltInAgents()
    const explore = agents.find(agent => agent.agentType === 'Explore')
    const plan = agents.find(agent => agent.agentType === 'Plan')
    const context = { toolUseContext: { options: {} as never } }
    const explorePrompt = explore?.getSystemPrompt(context)
    const planPrompt = plan?.getSystemPrompt(context)

    expect(explorePrompt).toContain('READ-ONLY')
    expect(explorePrompt).toContain('state-changing command')
    expect(explorePrompt?.length).toBeLessThan(1_400)
    expect(planPrompt).toContain('READ-ONLY')
    expect(planPrompt).toContain('Critical Files for Implementation')
    expect(planPrompt?.length).toBeLessThan(1_600)
  })
})

describe('Coordinator built-in worker agent', () => {
  test('returns the worker definition used in coordinator mode', () => {
    const agents = getCoordinatorAgents()

    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({
      agentType: 'worker',
      whenToUse:
        'For executing tasks autonomously — research, implementation, or verification.',
      tools: ['*'],
      maxTurns: 200,
      permissionMode: 'bubble',
      source: 'built-in',
      baseDir: 'built-in',
    })
    expect(agents[0]?.getSystemPrompt({
      toolUseContext: { options: {} as never },
    })).toBe(getWorkerSystemPrompt())
  })

  test('includes worker operating rules in the system prompt', () => {
    const prompt = getWorkerSystemPrompt()

    expect(prompt).toContain(
      'You are a worker agent executing a task assigned by the coordinator.',
    )
    expect(prompt).toContain('Do not spawn subagents (Agent tool)')
    expect(prompt).toContain('If a tool is denied')
    expect(prompt).toContain('Summary:')
  })
})
