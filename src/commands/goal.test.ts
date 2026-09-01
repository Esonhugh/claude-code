import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import {
  getSessionId,
  setIsInteractive,
  switchSession,
} from '../bootstrap/state.js'
import type { AppState } from '../state/AppState.js'
import type { AttachmentMessage } from '../types/message.js'
import type { PromptCommand } from '../types/command.js'
import type { ToolUseContext } from '../Tool.js'
import type { Attachment } from '../utils/attachments.js'
import {
  addSessionHook,
  getSessionHookBySource,
  getSessionHooks,
} from '../utils/hooks/sessionHooks.js'
import { restoreGoalSessionFromLog } from '../utils/sessionRestore.js'
import { isLoggableMessage } from '../utils/sessionStorage.js'
import { setCachedSettingsForSource } from '../utils/settings/settingsCache.js'
import {
  consumeLastGoalCommandAttachment,
  consumeLastGoalHookRegistration,
  createActiveGoalStatus,
  createGoalStatusAttachment,
  finishGoalStatus,
  formatGoalStatusText,
  getGoalPromptForState,
  goalNonInteractive,
} from './goal.js'
import {
  clearGoalOnHookSuccess,
  createGoalStopHook,
  GOAL_HOOKS_RESTRICTED_MESSAGE,
  recordGoalHookBlock,
  registerGoalStopHook,
  restoreGoalStopHook,
} from './goal/hooks.js'
import {
  applyGoalStatusAttachment,
  findGoalToRestore,
  restoreGoalFromTranscript,
} from './goal/restore.js'
import {
  GOAL_HOOK_ID,
  type GoalStatus,
  type GoalStatusAttachment,
} from './goal/types.js'

setIsInteractive(false)

const goalCommand = goalNonInteractive as PromptCommand

type GoalState = {
  goalStatus: GoalStatus
  sessionHooks: Map<string, { hooks: Record<string, unknown[]> }>
}

function createContext(initial: GoalStatus) {
  let state: GoalState = {
    goalStatus: { ...initial } as GoalStatus,
    sessionHooks: new Map(),
  }
  const context = {
    setAppState: (updater: (prev: AppState) => AppState) => {
      state = updater(state as AppState) as unknown as GoalState
    },
    getAppState: () => state as unknown as AppState,
  } as Pick<ToolUseContext, 'setAppState' | 'getAppState'> as ToolUseContext

  return {
    context,
    getState: () => state,
  }
}

const active = createActiveGoalStatus('goal-1', 'ship feature', 1000, 25)
assert.deepEqual(active, {
  active: true,
  id: 'goal-1',
  prompt: 'ship feature',
  iterations: 0,
  setAt: 1000,
  tokensAtStart: 25,
})
assert.equal(
  formatGoalStatusText(active),
  'Goal active: ship feature (not yet evaluated)',
)
assert.equal(
  formatGoalStatusText({
    ...active,
    iterations: 2,
    lastReason: 'tests still failing',
  }),
  'Goal active: ship feature (2 turns)\nLast check: tests still failing',
)
assert.deepEqual(finishGoalStatus(active, 'met', 2000, 70), {
  active: false,
  lastCompleted: {
    id: 'goal-1',
    prompt: 'ship feature',
    status: 'met',
    completedAt: 2000,
    iterations: 0,
    durationMs: 1000,
    tokens: 45,
  },
})
assert.deepEqual(createGoalStatusAttachment(active, 'active'), {
  type: 'goal_status',
  id: 'goal-1',
  condition: 'ship feature',
  status: 'active',
  sentinel: true,
  met: false,
  failed: false,
  iterations: 0,
  setAt: 1000,
  tokensAtStart: 25,
})
assert.deepEqual(createGoalStatusAttachment(active, 'met'), {
  type: 'goal_status',
  id: 'goal-1',
  condition: 'ship feature',
  status: 'met',
  sentinel: true,
  met: true,
  failed: false,
  iterations: 0,
})
assert.equal(getGoalPromptForState('  x  '), 'x')

const setContext = createContext({ active: false })
await goalCommand.getPromptForCommand(
  '  finish the feature  ',
  setContext.context,
)
const setState = setContext.getState().goalStatus
assert.equal(setState.active, true)
assert.equal(
  setState.active ? setState.prompt : undefined,
  'finish the feature',
)
assert.equal(setState.active ? setState.iterations : undefined, 0)
assert.ok(setState.active ? setState.id.length > 0 : false)
assert.deepEqual(consumeLastGoalCommandAttachment(), {
  type: 'goal_status',
  id: setState.active ? setState.id : '',
  condition: 'finish the feature',
  status: 'active',
  sentinel: true,
  met: false,
  failed: false,
  iterations: 0,
  setAt: setState.active ? setState.setAt : 0,
  tokensAtStart: setState.active ? setState.tokensAtStart : undefined,
})
assert.deepEqual(consumeLastGoalHookRegistration(), {
  id: setState.active ? setState.id : '',
  condition: 'finish the feature',
})

const emptyContext = createContext({ active: false })
const emptyPrompt = await goalCommand.getPromptForCommand(
  '',
  emptyContext.context,
)
assert.deepEqual(emptyContext.getState().goalStatus, { active: false })
assert.deepEqual(emptyPrompt, [
  { type: 'text', text: 'No goal set. Usage: `/goal <condition>`' },
])
assert.equal(goalCommand.shouldRegisterHooksForCommand?.(''), false)
assert.equal(goalCommand.shouldQueryForCommand?.(''), false)

const statusContext = createContext({
  active: true,
  id: 'goal-status',
  prompt: 'finish docs',
  iterations: 1,
  setAt: 0,
  lastReason: 'need tests',
})
const statusPrompt = await goalCommand.getPromptForCommand(
  '',
  statusContext.context,
)
assert.deepEqual(statusPrompt, [
  {
    type: 'text',
    text: 'Goal active: finish docs (1 turn)\nLast check: need tests',
  },
])

for (const alias of ['clear', 'stop', 'off', 'reset', 'none', 'cancel']) {
  assert.equal(goalCommand.shouldRegisterHooksForCommand?.(` ${alias} `), false)
  assert.equal(goalCommand.shouldQueryForCommand?.(` ${alias} `), false)
}

const tooLong = 'x'.repeat(4001)
const longContext = createContext({ active: false })
const longPrompt = await goalCommand.getPromptForCommand(
  tooLong,
  longContext.context,
)
assert.deepEqual(longContext.getState().goalStatus, { active: false })
assert.deepEqual(longPrompt, [
  {
    type: 'text',
    text: 'Goal condition is limited to 4000 characters (got 4001)',
  },
])
assert.equal(goalCommand.shouldRegisterHooksForCommand?.(tooLong), false)
assert.equal(goalCommand.shouldQueryForCommand?.(tooLong), false)

setCachedSettingsForSource('policySettings', { allowManagedHooksOnly: true })
const restrictedContext = createContext({ active: false })
const restrictedPrompt = await goalCommand.getPromptForCommand(
  'restricted goal',
  restrictedContext.context,
)
assert.deepEqual(restrictedPrompt, [
  { type: 'text', text: GOAL_HOOKS_RESTRICTED_MESSAGE },
])
assert.deepEqual(restrictedContext.getState().goalStatus, { active: false })
assert.equal(
  goalCommand.shouldRegisterHooksForCommand?.('restricted goal'),
  false,
)
assert.equal(goalCommand.shouldQueryForCommand?.('restricted goal'), false)
setCachedSettingsForSource('policySettings', null)

const clearContext = createContext({
  active: true,
  id: 'goal-clear',
  prompt: 'old goal',
  iterations: 0,
  setAt: 100,
})
addSessionHook(
  clearContext.context.setAppState,
  getSessionId(),
  'Stop',
  '',
  createGoalStopHook('old goal'),
  undefined,
  GOAL_HOOK_ID,
)
assert.ok(
  getSessionHooks(clearContext.getState() as never, getSessionId()).get('Stop'),
  'precondition: Stop hook should be registered before /goal clear',
)

const clearPrompt = await goalCommand.getPromptForCommand(
  ' clear ',
  clearContext.context,
)
assert.equal(clearContext.getState().goalStatus.active, false)
assert.deepEqual(clearPrompt, [
  { type: 'text', text: 'Goal cleared: old goal' },
])
assert.equal(
  getSessionHooks(clearContext.getState() as never, getSessionId()).get('Stop'),
  undefined,
  '/goal clear must unregister the Stop hook',
)
assert.deepEqual(consumeLastGoalCommandAttachment(), {
  type: 'goal_status',
  id: 'goal-clear',
  condition: 'old goal',
  status: 'cleared',
  sentinel: true,
  met: true,
  failed: false,
  iterations: 0,
})

const noGoalClearContext = createContext({ active: false })
const noGoalClearPrompt = await goalCommand.getPromptForCommand(
  ' cancel ',
  noGoalClearContext.context,
)
assert.deepEqual(noGoalClearPrompt, [{ type: 'text', text: 'No goal set' }])
assert.deepEqual(createGoalStopHook('finish tests'), {
  type: 'prompt',
  prompt: 'finish tests',
})

const autoClearContext = createContext({
  active: true,
  id: 'goal-auto-clear',
  prompt: 'finish docs',
  iterations: 1,
  setAt: 1000,
  tokensAtStart: 25,
})
let appendedGoalAttachment: GoalStatusAttachment | undefined
registerGoalStopHook({
  setAppState: autoClearContext.context.setAppState,
  sessionId: getSessionId(),
  goalId: 'goal-auto-clear',
  condition: 'finish docs',
  appendGoalStatusAttachment: (attachment) => {
    appendedGoalAttachment = attachment
  },
  now: () => 2000,
})
assert.ok(
  getSessionHooks(autoClearContext.getState() as never, getSessionId()).get(
    'Stop',
  ),
  'goal Stop hook should be registered',
)
clearGoalOnHookSuccess(
  {
    setAppState: autoClearContext.context.setAppState,
    sessionId: getSessionId(),
    goalId: 'goal-auto-clear',
    condition: 'finish docs',
    appendGoalStatusAttachment: (attachment) => {
      appendedGoalAttachment = attachment
    },
    now: () => 2000,
    currentTokens: () => 70,
  },
  { stopReason: 'verified complete' },
)
assert.deepEqual(autoClearContext.getState().goalStatus, {
  active: false,
  lastCompleted: {
    id: 'goal-auto-clear',
    prompt: 'finish docs',
    status: 'met',
    completedAt: 2000,
    iterations: 2,
    durationMs: 1000,
    tokens: 45,
    reason: 'verified complete',
  },
})
assert.deepEqual(appendedGoalAttachment, {
  type: 'goal_status',
  id: 'goal-auto-clear',
  condition: 'finish docs',
  status: 'met',
  sentinel: true,
  met: true,
  failed: false,
  iterations: 2,
  durationMs: 1000,
  tokens: 45,
  reason: 'verified complete',
})

const blockedContext = createContext({
  active: true,
  id: 'goal-blocked',
  prompt: 'finish tests',
  iterations: 2,
  setAt: 1000,
})
let blockedAttachment: GoalStatusAttachment | undefined
recordGoalHookBlock(
  {
    setAppState: blockedContext.context.setAppState,
    sessionId: getSessionId(),
    goalId: 'goal-blocked',
    condition: 'finish tests',
    appendGoalStatusAttachment: (attachment) => {
      blockedAttachment = attachment
    },
  },
  'one test still fails',
)
assert.deepEqual(blockedContext.getState().goalStatus, {
  active: true,
  id: 'goal-blocked',
  prompt: 'finish tests',
  iterations: 3,
  setAt: 1000,
  lastReason: 'one test still fails',
})
assert.deepEqual(blockedAttachment, {
  type: 'goal_status',
  id: 'goal-blocked',
  condition: 'finish tests',
  status: 'active',
  sentinel: true,
  met: false,
  failed: false,
  iterations: 3,
  setAt: 1000,
  reason: 'one test still fails',
})

const impossibleContext = createContext({
  active: true,
  id: 'goal-impossible',
  prompt: 'unreachable condition',
  iterations: 2,
  setAt: 1000,
})
let impossibleAttachment: GoalStatusAttachment | undefined
clearGoalOnHookSuccess(
  {
    setAppState: impossibleContext.context.setAppState,
    sessionId: getSessionId(),
    goalId: 'goal-impossible',
    condition: 'unreachable condition',
    appendGoalStatusAttachment: (attachment) => {
      impossibleAttachment = attachment
    },
    now: () => 2500,
  },
  { impossible: true, stopReason: 'required capability is unavailable' },
)
assert.deepEqual(impossibleContext.getState().goalStatus, {
  active: false,
  lastCompleted: {
    id: 'goal-impossible',
    prompt: 'unreachable condition',
    status: 'failed',
    completedAt: 2500,
    iterations: 3,
    durationMs: 1500,
    reason: 'required capability is unavailable',
  },
})
assert.deepEqual(impossibleAttachment, {
  type: 'goal_status',
  id: 'goal-impossible',
  condition: 'unreachable condition',
  status: 'failed',
  sentinel: true,
  met: false,
  failed: true,
  iterations: 3,
  durationMs: 1500,
  reason: 'required capability is unavailable',
})

const staleContext = createContext({
  active: true,
  id: 'new-goal',
  prompt: 'new goal',
  iterations: 0,
  setAt: 0,
})
clearGoalOnHookSuccess({
  setAppState: staleContext.context.setAppState,
  sessionId: getSessionId(),
  goalId: 'old-goal',
  condition: 'old goal',
  appendGoalStatusAttachment: () => {
    throw new Error('stale hook must not append')
  },
})
assert.deepEqual(staleContext.getState().goalStatus, {
  active: true,
  id: 'new-goal',
  prompt: 'new goal',
  iterations: 0,
  setAt: 0,
})

const goalAttachmentForTypeCheck: Attachment = {
  type: 'goal_status',
  id: 'goal-typecheck',
  condition: 'finish type support',
  status: 'active',
  sentinel: true,
  met: false,
  failed: false,
} satisfies GoalStatusAttachment
assert.equal(goalAttachmentForTypeCheck.type, 'goal_status')
assert.equal(
  isLoggableMessage(goalAttachmentMessage(goalAttachmentForTypeCheck)),
  true,
  'goal status attachments must persist so /resume can restore active goals',
)

function goalAttachmentMessage(
  attachment: GoalStatusAttachment,
): AttachmentMessage {
  return {
    type: 'attachment',
    uuid: randomUUID(),
    timestamp: new Date(0).toISOString(),
    attachment,
  }
}

const activeGoalAttachment: GoalStatusAttachment = {
  type: 'goal_status',
  id: 'restore-1',
  condition: 'restore me',
  status: 'active',
  sentinel: true,
  met: false,
  failed: false,
  setAt: 100,
  tokensAtStart: 25,
}
assert.deepEqual(
  findGoalToRestore([goalAttachmentMessage(activeGoalAttachment)]),
  activeGoalAttachment,
)

const metGoalAttachment: GoalStatusAttachment = {
  ...activeGoalAttachment,
  status: 'met',
  met: true,
}
assert.equal(
  findGoalToRestore([
    goalAttachmentMessage(activeGoalAttachment),
    goalAttachmentMessage(metGoalAttachment),
  ]),
  null,
)

const restoreContext = createContext({ active: false })
restoreGoalFromTranscript(
  [goalAttachmentMessage(activeGoalAttachment)],
  restoreContext.context.setAppState,
  () => 0,
)
assert.deepEqual(restoreContext.getState().goalStatus, {
  active: true,
  id: 'restore-1',
  prompt: 'restore me',
  iterations: 0,
  setAt: 100,
  tokensAtStart: 25,
})
const restoredSessionId = 'restored-session'
restoreGoalStopHook(
  restoreContext.context.setAppState,
  () => {},
  restoredSessionId,
)
assert.deepEqual(
  getSessionHookBySource(
    restoreContext.getState() as never,
    restoredSessionId,
    'Stop',
    '',
    GOAL_HOOK_ID,
  )?.hook,
  createGoalStopHook('restore me'),
)
assert.equal(
  getSessionHookBySource(
    restoreContext.getState() as never,
    getSessionId(),
    'Stop',
    '',
    GOAL_HOOK_ID,
  ),
  undefined,
)

const resumedSessionId = 'resumed-session'
switchSession(resumedSessionId as never)
const resumedContext = createContext({ active: false })
restoreGoalSessionFromLog(
  [goalAttachmentMessage(activeGoalAttachment)],
  resumedContext.context.setAppState,
)
assert.deepEqual(resumedContext.getState().goalStatus, {
  active: true,
  id: 'restore-1',
  prompt: 'restore me',
  iterations: 0,
  setAt: 100,
  tokensAtStart: 25,
})
assert.deepEqual(
  getSessionHookBySource(
    resumedContext.getState() as never,
    resumedSessionId,
    'Stop',
    '',
    GOAL_HOOK_ID,
  )?.hook,
  createGoalStopHook('restore me'),
)

setCachedSettingsForSource('policySettings', { allowManagedHooksOnly: true })
const restrictedResumeContext = createContext({ active: false })
restoreGoalSessionFromLog(
  [goalAttachmentMessage(activeGoalAttachment)],
  restrictedResumeContext.context.setAppState,
)
assert.deepEqual(restrictedResumeContext.getState().goalStatus, { active: false })
assert.equal(
  getSessionHookBySource(
    restrictedResumeContext.getState() as never,
    resumedSessionId,
    'Stop',
    '',
    GOAL_HOOK_ID,
  ),
  undefined,
)
setCachedSettingsForSource('policySettings', null)

const inactiveResumeContext = createContext({ active: false })
addSessionHook(
  inactiveResumeContext.context.setAppState,
  resumedSessionId,
  'Stop',
  '',
  createGoalStopHook('stale goal'),
  undefined,
  GOAL_HOOK_ID,
)
restoreGoalSessionFromLog([], inactiveResumeContext.context.setAppState)
assert.equal(
  getSessionHookBySource(
    inactiveResumeContext.getState() as never,
    resumedSessionId,
    'Stop',
    '',
    GOAL_HOOK_ID,
  ),
  undefined,
  'resuming a transcript without an active goal must remove a stale goal hook',
)

const projectedGoalContext = createContext({
  active: true,
  id: 'projected-1',
  prompt: 'project state',
  iterations: 1,
  setAt: 100,
})
applyGoalStatusAttachment(
  {
    type: 'goal_status',
    id: 'projected-1',
    condition: 'project state',
    status: 'failed',
    sentinel: true,
    iterations: 4,
    durationMs: 250,
    tokens: 90,
    reason: 'verification failed',
  },
  projectedGoalContext.context.setAppState,
  () => 500,
)
assert.deepEqual(projectedGoalContext.getState().goalStatus, {
  active: false,
  lastCompleted: {
    id: 'projected-1',
    prompt: 'project state',
    status: 'failed',
    completedAt: 500,
    iterations: 4,
    durationMs: 250,
    tokens: 90,
    reason: 'verification failed',
  },
})

assert.equal(
  goalCommand.shouldRegisterHooksForCommand?.('finish the feature'),
  true,
)
assert.equal(goalCommand.shouldQueryForCommand?.('finish the feature'), true)

console.log('goal.test.ts passed')
