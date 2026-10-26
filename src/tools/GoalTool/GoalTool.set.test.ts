import assert from 'node:assert/strict'

import { getSessionId, setIsInteractive } from '../../bootstrap/state.js'
import { stringWidth } from '../../ink/stringWidth.js'
import type { AppState } from '../../state/AppState.js'
import type { AttachmentMessage } from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import { getSessionHooks } from '../../utils/hooks/sessionHooks.js'
import { setCachedSettingsForSource } from '../../utils/settings/settingsCache.js'
import { GOAL_HOOKS_RESTRICTED_MESSAGE } from '../../commands/goal/hooks.js'
import type { GoalStatus } from '../../commands/goal/types.js'
import { GOAL_TOOL_NAME } from './constants.js'
import { GoalTool } from './GoalTool.js'

setIsInteractive(false)

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

const shortGoal = 'finish the feature'
assert.equal(
  GoalTool.renderToolUseMessage(
    { action: 'set', goal: shortGoal },
    { theme: 'dark', verbose: false },
  ),
  shortGoal,
)

const multilineGoal = `first line\n${'x'.repeat(200)}`
assert.equal(
  GoalTool.renderToolUseMessage(
    { action: 'set', goal: multilineGoal },
    { theme: 'dark', verbose: false },
  ),
  'first line…',
)
assert.equal(
  GoalTool.renderToolUseMessage(
    { action: 'set', goal: multilineGoal },
    { theme: 'dark', verbose: true },
  ),
  multilineGoal,
)

const longGoal = 'x'.repeat(200)
const summarizedGoal = GoalTool.renderToolUseMessage(
  { action: 'set', goal: longGoal },
  { theme: 'dark', verbose: false },
)
assert.equal(typeof summarizedGoal, 'string')
assert.equal(stringWidth(summarizedGoal as string), 160)
assert.match(summarizedGoal as string, /…$/)

const wideGoal = '目'.repeat(100)
const summarizedWideGoal = GoalTool.renderToolUseMessage(
  { action: 'set', goal: wideGoal },
  { theme: 'dark', verbose: false },
)
assert.equal(typeof summarizedWideGoal, 'string')
assert.equal(stringWidth(summarizedWideGoal as string), 159)
assert.match(summarizedWideGoal as string, /…$/)

const emptyContext = createContext({ active: false })
assert.deepEqual(
  await GoalTool.validateInput?.({ action: 'set', goal: '   ' }, emptyContext.context),
  {
    result: false,
    message: 'Goal must not be empty',
    errorCode: 1,
  },
)

const tooLong = 'x'.repeat(4001)
assert.deepEqual(
  await GoalTool.validateInput?.({ action: 'set', goal: tooLong }, emptyContext.context),
  {
    result: false,
    message: 'Goal condition is limited to 4000 characters (got 4001)',
    errorCode: 2,
  },
)

setCachedSettingsForSource('policySettings', { allowManagedHooksOnly: true })
const restrictedContext = createContext({ active: false })
assert.deepEqual(
  await GoalTool.validateInput?.(
    { action: 'set', goal: 'restricted goal' },
    restrictedContext.context,
  ),
  {
    result: false,
    message: GOAL_HOOKS_RESTRICTED_MESSAGE,
    errorCode: 4,
  },
)
await assert.rejects(
  GoalTool.call({ action: 'set', goal: 'restricted goal' }, restrictedContext.context),
  error => {
    assert.equal((error as Error).message, GOAL_HOOKS_RESTRICTED_MESSAGE)
    return true
  },
)
assert.deepEqual(restrictedContext.getState().goalStatus, { active: false })
setCachedSettingsForSource('policySettings', null)

const setContext = createContext({ active: false })
const setResult = await GoalTool.call(
  { action: 'set', goal: '  finish the feature  ' },
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
  setAt: active.active ? active.setAt : 0,
  tokensAtStart: active.active ? active.tokensAtStart : undefined,
})
assert.ok(
  getSessionHooks(setContext.getState() as never, getSessionId()).get('Stop'),
  'Goal set must register the existing goal Stop hook',
)
const toolResult = GoalTool.mapToolResultToToolResultBlockParam(
  setResult.data,
  'tool-use-1',
)
assert.equal(toolResult.type, 'tool_result')
assert.equal(toolResult.tool_use_id, 'tool-use-1')
assert.match(toolResult.content as string, /^Goal set: finish the feature/)
assert.match(toolResult.content as string, /Work autonomously toward this goal/)

const firstGoalId = active.active ? active.id : ''
await GoalTool.call(
  { action: 'set', goal: 'replacement goal' },
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
  await GoalTool.validateInput?.({ action: 'set', goal: 'agent goal' }, agentContext.context),
  {
    result: false,
    message: 'Goal cannot be used in agent contexts',
    errorCode: 3,
  },
)
await assert.rejects(
  GoalTool.call({ action: 'set', goal: 'agent goal' }, agentContext.context),
  /Goal cannot be used in agent contexts/,
)
assert.deepEqual(agentContext.getState().goalStatus, { active: false })

console.log('GoalTool.set.test.ts passed')
