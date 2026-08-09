import assert from 'node:assert/strict'

import { getSessionId } from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import type { AttachmentMessage } from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import { getSessionHooks } from '../../utils/hooks/sessionHooks.js'
import type { GoalStatus } from '../../commands/goal/types.js'
import { SET_GOAL_TOOL_NAME } from './constants.js'
import { SetGoalTool } from './SetGoalTool.js'

type GoalState = {
  goalStatus: GoalStatus
  sessionHooks: Map<string, { hooks: Record<string, unknown[]> }>
}

function createContext(initial: GoalStatus, agentId?: string) {
  let state: GoalState = {
    goalStatus: { ...initial } as GoalStatus,
    sessionHooks: new Map(),
  }
  const context = {
    agentId,
    setAppState: (updater: (prev: AppState) => AppState) => {
      state = updater(state as AppState) as unknown as GoalState
    },
    getAppState: () => state as unknown as AppState,
  } as ToolUseContext

  return { context, getState: () => state }
}

assert.equal(SetGoalTool.name, SET_GOAL_TOOL_NAME)

const emptyContext = createContext({ active: false })
assert.deepEqual(
  await SetGoalTool.validateInput?.({ goal: '   ' }, emptyContext.context),
  {
    result: false,
    message: 'Goal must not be empty',
    errorCode: 1,
  },
)

const tooLong = 'x'.repeat(4001)
assert.deepEqual(
  await SetGoalTool.validateInput?.({ goal: tooLong }, emptyContext.context),
  {
    result: false,
    message: 'Goal condition is limited to 4000 characters (got 4001)',
    errorCode: 2,
  },
)

const setContext = createContext({ active: false })
const setResult = await SetGoalTool.call(
  { goal: '  finish the feature  ' },
  setContext.context,
)
const active = setContext.getState().goalStatus
assert.equal(active.active, true)
assert.equal(active.active ? active.prompt : undefined, 'finish the feature')
assert.equal(active.active ? active.iterations : undefined, 0)
assert.equal(setResult.data.goal, 'finish the feature')
assert.equal(setResult.newMessages?.length, 1)
assert.equal(setResult.newMessages?.[0]?.type, 'attachment')
assert.deepEqual((setResult.newMessages?.[0] as AttachmentMessage).attachment, {
  type: 'goal_status',
  id: active.active ? active.id : '',
  condition: 'finish the feature',
  status: 'active',
  sentinel: true,
  met: false,
  failed: false,
  iterations: 0,
})
assert.ok(
  getSessionHooks(setContext.getState() as never, getSessionId()).get('Stop'),
  'SetGoal must register the existing goal Stop hook',
)
const toolResult = SetGoalTool.mapToolResultToToolResultBlockParam(
  setResult.data,
  'tool-use-1',
)
assert.equal(toolResult.type, 'tool_result')
assert.equal(toolResult.tool_use_id, 'tool-use-1')
assert.match(toolResult.content as string, /^Goal set: finish the feature/)
assert.match(toolResult.content as string, /Work autonomously toward this goal/)

const firstGoalId = active.active ? active.id : ''
await SetGoalTool.call(
  { goal: 'replacement goal' },
  setContext.context,
)
const replaced = setContext.getState().goalStatus
assert.equal(replaced.active, true)
assert.equal(replaced.active ? replaced.prompt : undefined, 'replacement goal')
assert.notEqual(replaced.active ? replaced.id : '', firstGoalId)
const stopMatchers = getSessionHooks(
  setContext.getState() as never,
  getSessionId(),
).get('Stop')
assert.equal(stopMatchers?.length, 1)
assert.equal(
  stopMatchers?.[0]?.hooks.length,
  1,
  'replacing a goal must replace rather than duplicate the Stop hook',
)

const agentContext = createContext({ active: false }, 'agent-1')
assert.deepEqual(
  await SetGoalTool.validateInput?.({ goal: 'agent goal' }, agentContext.context),
  {
    result: false,
    message: 'SetGoal cannot be used in agent contexts',
    errorCode: 3,
  },
)
await assert.rejects(
  SetGoalTool.call({ goal: 'agent goal' }, agentContext.context),
  /SetGoal cannot be used in agent contexts/,
)
assert.deepEqual(agentContext.getState().goalStatus, { active: false })

console.log('SetGoalTool.test.ts passed')
