import assert from 'node:assert/strict'

import {
  ALL_AGENT_DISALLOWED_TOOLS,
  MAIN_THREAD_ONLY_TOOLS,
} from '../../constants/tools.js'
import { ClearGoalTool } from '../ClearGoalTool/ClearGoalTool.js'
import { CLEAR_GOAL_TOOL_NAME } from '../ClearGoalTool/constants.js'
import { SetGoalTool } from '../SetGoalTool/SetGoalTool.js'
import { SET_GOAL_TOOL_NAME } from '../SetGoalTool/constants.js'
import {
  filterToolsForAgent,
  filterToolsForExactAgent,
  resolveAgentTools,
} from './agentToolUtils.js'

const goalTools = [SetGoalTool, ClearGoalTool]
const goalToolNames = [SET_GOAL_TOOL_NAME, CLEAR_GOAL_TOOL_NAME]

for (const toolName of goalToolNames) {
  assert.equal(MAIN_THREAD_ONLY_TOOLS.has(toolName), true)
  assert.equal(ALL_AGENT_DISALLOWED_TOOLS.has(toolName), true)
}

for (const isAsync of [false, true]) {
  assert.deepEqual(
    filterToolsForAgent({
      tools: goalTools,
      isBuiltIn: true,
      isAsync,
    }),
    [],
  )
  assert.deepEqual(
    resolveAgentTools(
      { tools: ['*'], source: 'built-in' },
      goalTools,
      isAsync,
    ).resolvedTools,
    [],
  )
  assert.deepEqual(
    resolveAgentTools(
      { tools: goalToolNames, source: 'projectSettings' },
      goalTools,
      isAsync,
    ).resolvedTools,
    [],
  )
}

assert.deepEqual(filterToolsForExactAgent(goalTools), [])
assert.deepEqual(
  resolveAgentTools(
    { tools: ['*'], source: 'built-in' },
    goalTools,
    false,
    true,
  ).resolvedTools,
  goalTools,
  'main-thread resolution must keep goal tools available',
)

console.log('agentToolUtils.setGoal.test.ts passed')
