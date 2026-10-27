import assert from 'node:assert/strict'
import { isValidElement } from 'react'

import { getSessionId } from '../../bootstrap/state.js'
import { createGoalStopHook } from '../../commands/goal/hooks.js'
import { Text } from '../../ink.js'
import { GOAL_HOOK_ID, type GoalStatus } from '../../commands/goal/types.js'
import type { AppState } from '../../state/AppState.js'
import type { AttachmentMessage } from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  addSessionHook,
  getSessionHooks,
} from '../../utils/hooks/sessionHooks.js'
import { GOAL_TOOL_NAME } from './constants.js'
import { GoalTool } from './GoalTool.js'

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

assert.equal(GoalTool.name, GOAL_TOOL_NAME)
assert.equal(GoalTool.userFacingName(), GOAL_TOOL_NAME)
assert.equal(GoalTool.renderToolUseMessage({ action: 'clear' }, { theme: 'dark', verbose: false }), 'Clear active goal')

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

const clearResult = await GoalTool.call({ action: 'clear' }, clearContext.context)
assert.deepEqual(clearContext.getState().goalStatus, { active: false })
assert.equal(
  getSessionHooks(clearContext.getState() as never, getSessionId()).get('Stop'),
  undefined,
  'Goal clear must unregister the goal Stop hook',
)
assert.deepEqual(clearResult.data, {
  action: 'clear',
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
  GoalTool.mapToolResultToToolResultBlockParam(
    clearResult.data,
    'tool-use-clear',
  ),
  {
    type: 'tool_result',
    tool_use_id: 'tool-use-clear',
    content: 'Goal cleared: finish the feature',
  },
)
const clearedMessage = GoalTool.renderToolResultMessage?.(clearResult.data)
assert.ok(isValidElement<{ children: string }>(clearedMessage))
assert.equal(clearedMessage.type, Text)
assert.equal(clearedMessage.props.children, 'Goal cleared: finish the feature')

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
const noGoalResult = await GoalTool.call({ action: 'clear' }, noGoalContext.context)
assert.deepEqual(noGoalContext.getState().goalStatus, { active: false })
assert.equal(
  getSessionHooks(noGoalContext.getState() as never, getSessionId()).get(
    'Stop',
  ),
  undefined,
  'Goal clear must remove a stale goal Stop hook even when no goal is active',
)
assert.deepEqual(noGoalResult, {
  data: { action: 'clear', cleared: false },
})
assert.equal(
  GoalTool.mapToolResultToToolResultBlockParam(
    noGoalResult.data,
    'tool-use-no-goal',
  ).content,
  'No goal set',
)
const noGoalMessage = GoalTool.renderToolResultMessage?.(noGoalResult.data)
assert.ok(isValidElement<{ children: string }>(noGoalMessage))
assert.equal(noGoalMessage.type, Text)
assert.equal(noGoalMessage.props.children, 'No goal set')

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
  await GoalTool.validateInput?.({ action: 'clear' }, agentContext.context),
  {
    result: false,
    message: 'Goal cannot be used in agent contexts',
    errorCode: 3,
  },
)
await assert.rejects(
  GoalTool.call({ action: 'clear' }, agentContext.context),
  /Goal cannot be used in agent contexts/,
)
assert.equal(agentContext.getState().goalStatus.active, true)

console.log('GoalTool.clear.test.ts passed')
