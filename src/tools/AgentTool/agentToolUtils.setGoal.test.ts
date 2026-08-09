import assert from 'node:assert/strict'

import {
  ALL_AGENT_DISALLOWED_TOOLS,
  MAIN_THREAD_ONLY_TOOLS,
} from '../../constants/tools.js'
import { SetGoalTool } from '../SetGoalTool/SetGoalTool.js'
import { SET_GOAL_TOOL_NAME } from '../SetGoalTool/constants.js'
import {
  filterToolsForAgent,
  filterToolsForExactAgent,
  resolveAgentTools,
} from './agentToolUtils.js'

assert.equal(MAIN_THREAD_ONLY_TOOLS.has(SET_GOAL_TOOL_NAME), true)
assert.equal(ALL_AGENT_DISALLOWED_TOOLS.has(SET_GOAL_TOOL_NAME), true)

for (const isAsync of [false, true]) {
  assert.deepEqual(
    filterToolsForAgent({
      tools: [SetGoalTool],
      isBuiltIn: true,
      isAsync,
    }),
    [],
  )
  assert.deepEqual(
    resolveAgentTools(
      { tools: ['*'], source: 'built-in' },
      [SetGoalTool],
      isAsync,
    ).resolvedTools,
    [],
  )
  assert.deepEqual(
    resolveAgentTools(
      { tools: [SET_GOAL_TOOL_NAME], source: 'projectSettings' },
      [SetGoalTool],
      isAsync,
    ).resolvedTools,
    [],
  )
}

assert.deepEqual(filterToolsForExactAgent([SetGoalTool]), [])
assert.deepEqual(
  resolveAgentTools(
    { tools: ['*'], source: 'built-in' },
    [SetGoalTool],
    false,
    true,
  ).resolvedTools,
  [SetGoalTool],
  'main-thread resolution must keep SetGoal available',
)

console.log('agentToolUtils.setGoal.test.ts passed')
