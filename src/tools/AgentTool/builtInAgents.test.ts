import assert from 'node:assert/strict'

import {
  areExplorePlanAgentsEnabled,
  getBuiltInAgents,
} from './builtInAgents.js'

const originalDisableExplorePlanAgents =
  process.env.CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS

try {
  delete process.env.CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS
  assert.equal(areExplorePlanAgentsEnabled(), true)
  assert.ok(getBuiltInAgents().some(agent => agent.agentType === 'Explore'))
  assert.ok(getBuiltInAgents().some(agent => agent.agentType === 'Plan'))

  process.env.CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS = '1'
  assert.equal(areExplorePlanAgentsEnabled(), false)
  assert.ok(!getBuiltInAgents().some(agent => agent.agentType === 'Explore'))
  assert.ok(!getBuiltInAgents().some(agent => agent.agentType === 'Plan'))
} finally {
  if (originalDisableExplorePlanAgents === undefined) {
    delete process.env.CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS
  } else {
    process.env.CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS =
      originalDisableExplorePlanAgents
  }
}

console.log('builtInAgents.test.ts passed')
