import assert from 'node:assert/strict'
import React from 'react'
import { PassThrough, Readable } from 'stream'
import stripAnsi from 'strip-ansi'
import type { Message } from '../../types/message.js'

import {
  getSessionId,
  setIsInteractive,
  setSessionTrustAccepted,
} from '../../bootstrap/state.js'
import { AppStoreContext, getDefaultAppState } from '../../state/AppState.js'
import type { AppState } from '../../state/AppStateStore.js'
import { createStore } from '../../state/store.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import { resetTrustDialogAcceptedCacheForTesting } from '../../utils/config.js'
import { getSessionHookBySource } from '../../utils/hooks/sessionHooks.js'
import { setCachedSettingsForSource } from '../../utils/settings/settingsCache.js'
import {
  GOAL_HOOKS_RESTRICTED_MESSAGE,
  GOAL_WORKSPACE_UNTRUSTED_MESSAGE,
} from './hooks.js'
import { render } from '../../ink.js'
import { AttachmentMessage } from '../../components/messages/AttachmentMessage.js'
import { isNullRenderingAttachment } from '../../components/messages/nullRenderingAttachments.js'
import { GoalStatusDialog, call } from './goal.js'
import {
  GOAL_HOOK_ID,
  type GoalStatus,
  type GoalStatusAttachment,
} from './types.js'

process.env.NODE_ENV = 'test'
process.env.ANTHROPIC_API_KEY = 'test-key'
setIsInteractive(true)
setSessionTrustAccepted(true)

function createContext(initial: GoalStatus) {
  let state = {
    ...getDefaultAppState(),
    goalStatus: initial,
  } as AppState
  const context = {
    getAppState: () => state,
    setAppState: (updater: (prev: AppState) => AppState) => {
      state = updater(state)
    },
  } as LocalJSXCommandContext
  return { context, getState: () => state }
}

let completion:
  | { result?: string; options?: Parameters<LocalJSXCommandOnDone>[1] }
  | undefined
const onDone: LocalJSXCommandOnDone = (result, options) => {
  completion = { result, options }
}

const setContext = createContext({ active: false })
const setResult = await call(onDone, setContext.context, ' ship feature ')
assert.equal(setResult, null)
assert.equal(completion?.result, 'Goal set: ship feature')
assert.equal(completion?.options?.shouldQuery, true)
assert.equal(completion?.options?.metaMessages?.length, 1)
assert.match(completion?.options?.metaMessages?.[0] ?? '', /ship feature/)
assert.equal(completion?.options?.additionalMessages?.length, 1)
const activeAttachment = completion?.options?.additionalMessages?.[0]
assert.equal(activeAttachment?.type, 'attachment')
assert.equal(activeAttachment?.attachment.type, 'goal_status')
assert.equal(
  activeAttachment?.attachment.type === 'goal_status'
    ? activeAttachment.attachment.status
    : undefined,
  'active',
)
const setState = setContext.getState()
assert.equal(setState.goalStatus.active, true)
assert.ok(
  getSessionHookBySource(
    setState,
    getSessionId(),
    'Stop',
    '',
    GOAL_HOOK_ID,
  ),
)

completion = undefined
await call(onDone, setContext.context, 'clear')
assert.equal(completion?.result, 'Goal cleared: ship feature')
assert.equal(completion?.options?.display, 'system')
assert.equal(completion?.options?.additionalMessages?.length, 1)
assert.equal(setContext.getState().goalStatus.active, false)
assert.equal(
  getSessionHookBySource(
    setContext.getState(),
    getSessionId(),
    'Stop',
    '',
    GOAL_HOOK_ID,
  ),
  undefined,
)

completion = undefined
const emptyContext = createContext({ active: false })
const statusResult = await call(onDone, emptyContext.context, '')
assert.ok(React.isValidElement(statusResult))
assert.equal(completion, undefined)

const untrustedContext = createContext({ active: false })
setSessionTrustAccepted(false)
resetTrustDialogAcceptedCacheForTesting()
completion = undefined
await call(onDone, untrustedContext.context, 'restricted goal')
assert.equal(completion?.result, GOAL_WORKSPACE_UNTRUSTED_MESSAGE)
assert.equal(completion?.options?.display, 'system')
assert.deepEqual(untrustedContext.getState().goalStatus, { active: false })
assert.equal(
  getSessionHookBySource(
    untrustedContext.getState(),
    getSessionId(),
    'Stop',
    '',
    GOAL_HOOK_ID,
  ),
  undefined,
)

setSessionTrustAccepted(true)

setCachedSettingsForSource('policySettings', { allowManagedHooksOnly: true })
const restrictedContext = createContext({ active: false })
completion = undefined
await call(onDone, restrictedContext.context, 'restricted goal')
assert.equal(completion?.result, GOAL_HOOKS_RESTRICTED_MESSAGE)
assert.equal(completion?.options?.display, 'system')
assert.deepEqual(restrictedContext.getState().goalStatus, { active: false })
assert.equal(
  getSessionHookBySource(
    restrictedContext.getState(),
    getSessionId(),
    'Stop',
    '',
    GOAL_HOOK_ID,
  ),
  undefined,
)
setCachedSettingsForSource('policySettings', null)

class TestStdin extends Readable {
  isTTY = true
  isRaw = false

  _read() {}

  setRawMode(value: boolean) {
    this.isRaw = value
    return this
  }

  ref() {
    return this
  }

  unref() {
    return this
  }
}

async function renderWithState(
  node: React.ReactNode,
  goalStatus: GoalStatus = { active: false },
): Promise<string> {
  const state = {
    ...getDefaultAppState(),
    goalStatus,
  } as AppState
  const stdout = new PassThrough() as PassThrough & { columns: number }
  const stdin = new TestStdin()
  stdout.columns = 100
  let output = ''
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  const instance = await render(
    <AppStoreContext.Provider value={createStore(state)}>
      {node}
    </AppStoreContext.Provider>,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
  try {
    await new Promise(resolve => setTimeout(resolve, 20))
    return stripAnsi(output)
  } finally {
    instance.unmount()
    instance.cleanup()
    stdin.destroy()
    stdout.destroy()
  }
}

function renderGoalStatus(goalStatus: GoalStatus): Promise<string> {
  return renderWithState(<GoalStatusDialog onDone={() => {}} />, goalStatus)
}

function renderGoalAttachment(
  attachment: GoalStatusAttachment,
  {
    isTranscriptMode = false,
    verbose = false,
  }: { isTranscriptMode?: boolean; verbose?: boolean } = {},
): Promise<string> {
  return renderWithState(
    <AttachmentMessage
      addMargin={false}
      attachment={attachment}
      verbose={verbose}
      isTranscriptMode={isTranscriptMode}
    />,
  )
}

const inactiveOutput = await renderGoalStatus({ active: false })
assert.match(inactiveOutput, /Goal/)
assert.match(inactiveOutput, /No goal set/)
assert.match(inactiveOutput, /\/goal <condition> to set one/)
assert.match(inactiveOutput, /Esc to dismiss/i)

const activeOutput = await renderGoalStatus({
  active: true,
  id: 'active-goal',
  prompt: 'finish implementation',
  iterations: 2,
  setAt: Date.now() - 5000,
  lastReason: 'tests remain',
})
assert.match(activeOutput, /◎ Goal active/)
assert.match(activeOutput, /running 5s/)
assert.match(activeOutput, /2 turns/)
assert.match(activeOutput, /finish implementation/)
assert.match(activeOutput, /Last check: tests remain/)
assert.match(activeOutput, /\/goal clear to stop early/)

const achievedOutput = await renderGoalStatus({
  active: false,
  lastCompleted: {
    id: 'met-goal',
    prompt: 'finish implementation',
    status: 'met',
    completedAt: 2000,
    iterations: 3,
    durationMs: 60_000,
    tokens: 1200,
  },
})
assert.match(achievedOutput, /Goal achieved/)
assert.match(achievedOutput, /1m/)
assert.match(achievedOutput, /3 turns/)
assert.match(achievedOutput, /1\.2k tokens/)
assert.match(achievedOutput, /\/goal <condition> to set another/)

const failedOutput = await renderGoalStatus({
  active: false,
  lastCompleted: {
    id: 'failed-goal',
    prompt: 'impossible goal',
    status: 'failed',
    completedAt: 2000,
    iterations: 1,
    durationMs: 1000,
    tokens: 25,
    reason: 'condition is impossible',
  },
})
assert.match(failedOutput, /Goal could not be achieved/)
assert.match(failedOutput, /impossible goal/)
assert.match(failedOutput, /Last check: condition is impossible/)

const sentinelAttachment: GoalStatusAttachment = {
  type: 'goal_status',
  id: 'sentinel-goal',
  condition: 'remain hidden',
  status: 'active',
  sentinel: true,
}
const sentinelOutput = await renderGoalAttachment(sentinelAttachment)
assert.equal(sentinelOutput, '')
const sentinelMessage = {
  type: 'attachment',
  uuid: '00000000-0000-4000-8000-000000000000',
  timestamp: new Date().toISOString(),
  attachment: sentinelAttachment,
} as Message
assert.equal(isNullRenderingAttachment(sentinelMessage), true)

const pendingAttachment: GoalStatusAttachment = {
  type: 'goal_status',
  id: 'pending-goal',
  condition: 'finish implementation',
  status: 'active',
  reason: 'tests remain',
}
const pendingOutput = await renderGoalAttachment(pendingAttachment)
assert.match(pendingOutput, /Goal not yet met… continuing/)
assert.match(pendingOutput, /to expand/)
assert.doesNotMatch(pendingOutput, /Goal: finish implementation/)
assert.doesNotMatch(pendingOutput, /Reason: tests remain/)

const verbosePendingOutput = await renderGoalAttachment(pendingAttachment, {
  verbose: true,
})
assert.match(verbosePendingOutput, /Goal: finish implementation/)
assert.match(verbosePendingOutput, /Reason: tests remain/)
assert.doesNotMatch(verbosePendingOutput, /to expand/)

const completedAttachmentOutput = await renderGoalAttachment({
  type: 'goal_status',
  id: 'completed-goal',
  condition: 'finish implementation',
  status: 'met',
  iterations: 3,
  durationMs: 60_000,
  tokens: 1200,
})
assert.match(completedAttachmentOutput, /Goal achieved/)
assert.match(completedAttachmentOutput, /1m · 3 turns · 1\.2k tokens/)

const failedAttachmentOutput = await renderGoalAttachment({
  type: 'goal_status',
  id: 'failed-goal',
  condition: 'impossible goal',
  status: 'failed',
  iterations: 1,
  durationMs: 1000,
  tokens: 25,
  reason: 'condition is impossible',
})
assert.match(failedAttachmentOutput, /Goal could not be achieved/)
assert.match(failedAttachmentOutput, /1s · 1 turn · 25 tokens/)

const clearedAttachmentOutput = await renderGoalAttachment({
  type: 'goal_status',
  id: 'cleared-goal',
  condition: 'stop early',
  status: 'cleared',
})
assert.match(clearedAttachmentOutput, /Goal cleared/)
assert.doesNotMatch(clearedAttachmentOutput, /Goal achieved/)

const transcriptOutput = await renderGoalAttachment(pendingAttachment, {
  isTranscriptMode: true,
})
assert.match(transcriptOutput, /Goal: finish implementation/)
assert.match(transcriptOutput, /Reason: tests remain/)
assert.doesNotMatch(transcriptOutput, /to expand/)

const transcriptFailedOutput = await renderGoalAttachment(
  {
    type: 'goal_status',
    id: 'failed-transcript-goal',
    condition: 'impossible goal',
    status: 'failed',
    reason: 'condition is impossible',
  },
  { isTranscriptMode: true },
)
assert.match(transcriptFailedOutput, /Goal: impossible goal/)
assert.match(transcriptFailedOutput, /condition is impossible/)
assert.doesNotMatch(transcriptFailedOutput, /Reason:/)

const conflictingLegacyOutput = await renderGoalAttachment({
  type: 'goal_status',
  id: 'conflicting-goal',
  condition: 'status is authoritative',
  status: 'failed',
  met: true,
  failed: false,
})
assert.match(conflictingLegacyOutput, /Goal could not be achieved/)
assert.doesNotMatch(conflictingLegacyOutput, /Goal achieved/)

console.log('goal/goal.test.tsx passed')
