import assert from 'node:assert/strict'

import { getSessionId } from '../../bootstrap/state.js'
import { createGoalStopHook } from '../../commands/goal/hooks.js'
import { GOAL_HOOK_ID, type GoalStatus } from '../../commands/goal/types.js'
import type { AppState } from '../../state/AppState.js'
import type { AttachmentMessage } from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  addSessionHook,
  getSessionHooks,
} from '../../utils/hooks/sessionHooks.js'
import { ClearGoalTool } from './ClearGoalTool.js'
import { CLEAR_GOAL_TOOL_NAME } from './constants.js'

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

assert.equal(ClearGoalTool.name, CLEAR_GOAL_TOOL_NAME)
assert.equal(ClearGoalTool.userFacingName(), CLEAR_GOAL_TOOL_NAME)
assert.equal(
  ClearGoalTool.renderToolUseMessage(
    {},
    { theme: 'dark', verbose: false },
  ),
  'Clear active goal',
)

const clearContext = createContext({
  active: true,
  id: 'goal-clear',
  prompt: 'finish the feature',
  iterations: 2,
  setAt: 100,
})
addSessionHook(
  clearContext.context.setAppState,
  getSessionId(),
  'Stop',
  '',
  createGoalStopHook('finish the feature'),
  undefined,
  GOAL_HOOK_ID,
)

const clearResult = await ClearGoalTool.call({}, clearContext.context)
assert.deepEqual(clearContext.getState().goalStatus, { active: false })
assert.equal(
  getSessionHooks(clearContext.getState() as never, getSessionId()).get('Stop'),
  undefined,
  'ClearGoal must unregister the goal Stop hook',
)
assert.deepEqual(clearResult.data, {
  cleared: true,
  goal: 'finish the feature',
})
assert.equal(clearResult.newMessages?.length, 1)
assert.deepEqual(
  (clearResult.newMessages?.[0] as AttachmentMessage).attachment,
  {
    type: 'goal_status',
    id: 'goal-clear',
    condition: 'finish the feature',
    status: 'cleared',
    sentinel: true,
    met: true,
    failed: false,
    iterations: 2,
  },
)
assert.deepEqual(
  ClearGoalTool.mapToolResultToToolResultBlockParam(
    clearResult.data,
    'tool-use-clear',
  ),
  {
    type: 'tool_result',
    tool_use_id: 'tool-use-clear',
    content: 'Goal cleared: finish the feature',
  },
)
assert.equal(
  ClearGoalTool.renderToolResultMessage?.(
    clearResult.data,
    [],
    { theme: 'dark', tools: [], verbose: false },
  ),
  'Goal cleared: finish the feature',
)

const noGoalContext = createContext({ active: false })
addSessionHook(
  noGoalContext.context.setAppState,
  getSessionId(),
  'Stop',
  '',
  createGoalStopHook('stale goal'),
  undefined,
  GOAL_HOOK_ID,
)
const noGoalResult = await ClearGoalTool.call({}, noGoalContext.context)
assert.deepEqual(noGoalContext.getState().goalStatus, { active: false })
assert.equal(
  getSessionHooks(noGoalContext.getState() as never, getSessionId()).get(
    'Stop',
  ),
  undefined,
  'ClearGoal must remove a stale goal Stop hook even when no goal is active',
)
assert.deepEqual(noGoalResult, {
  data: { cleared: false },
})
assert.equal(
  ClearGoalTool.mapToolResultToToolResultBlockParam(
    noGoalResult.data,
    'tool-use-no-goal',
  ).content,
  'No goal set',
)
assert.equal(
  ClearGoalTool.renderToolResultMessage?.(
    noGoalResult.data,
    [],
    { theme: 'dark', tools: [], verbose: false },
  ),
  'No goal set',
)

const agentContext = createContext(
  {
    active: true,
    id: 'agent-goal',
    prompt: 'agent goal',
    iterations: 0,
    setAt: 100,
  },
  'agent-1',
)
assert.deepEqual(
  await ClearGoalTool.validateInput?.({}, agentContext.context),
  {
    result: false,
    message: 'ClearGoal cannot be used in agent contexts',
    errorCode: 1,
  },
)
await assert.rejects(
  ClearGoalTool.call({}, agentContext.context),
  /ClearGoal cannot be used in agent contexts/,
)
assert.equal(agentContext.getState().goalStatus.active, true)

console.log('ClearGoalTool.test.ts passed')
