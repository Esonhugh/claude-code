import { afterEach, beforeEach, expect, test } from 'bun:test'
import { setIsInteractive } from '../bootstrap/state.js'
import type { AppState } from '../state/AppState.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { createTaskStateBase } from '../Task.js'
import { getTaskByType } from '../tasks.js'
import { drainSdkEvents } from '../utils/sdkEventQueue.js'
import type { InProcessTeammateTaskState } from './InProcessTeammateTask/types.js'
import type { LocalShellTaskState } from './LocalShellTask/guards.js'
import { killTask } from './LocalShellTask/killShellTasks.js'
import { stopTask, StopTaskError } from './stopTask.js'

let state: AppState
const getAppState = () => state
const setAppState = (update: (prev: AppState) => AppState) => {
  state = update(state)
}

function runningShellTask(id: string): LocalShellTaskState {
  return {
    ...createTaskStateBase(id, 'local_bash', 'sleep forever', 'toolu_bash'),
    type: 'local_bash',
    status: 'running',
    command: 'sleep 999',
    completionStatusSentInAttachment: false,
    shellCommand: null,
    lastReportedTotalLines: 0,
    isBackgrounded: true,
  }
}

function runningTeammateTask(id: string): InProcessTeammateTaskState {
  return {
    ...createTaskStateBase(id, 'in_process_teammate', 'researcher', 'toolu_mate'),
    type: 'in_process_teammate',
    status: 'running',
    identity: {
      agentId: 'researcher@stop-team',
      agentName: 'researcher',
      teamName: 'stop-team',
      planModeRequired: false,
      parentSessionId: 'session-stop-test',
    },
    prompt: 'inspect only',
    abortController: new AbortController(),
    awaitingPlanApproval: false,
    permissionMode: 'default',
    pendingUserMessages: [],
    isIdle: false,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
  }
}

beforeEach(() => {
  setIsInteractive(false)
  drainSdkEvents()
  state = { ...getDefaultAppState(), tasks: {} }
})
afterEach(() => {
  drainSdkEvents()
})

test('in_process_teammate is a stoppable task type', async () => {
  expect(getTaskByType('in_process_teammate')?.name).toBe('InProcessTeammateTask')
  state.tasks = { tmate1: runningTeammateTask('tmate1') }
  const result = await stopTask('tmate1', { getAppState, setAppState })
  expect(result.taskType).toBe('in_process_teammate')
  expect(state.tasks.tmate1?.status).toBe('killed')
})

test('stopTask rejects unknown task types', async () => {
  state.tasks = { x1: { ...runningShellTask('x1'), type: 'nope' as never } }
  await expect(stopTask('x1', { getAppState, setAppState })).rejects.toBeInstanceOf(StopTaskError)
})

test('killTask closes the SDK bookend exactly once for a running bash task', () => {
  state.tasks = { b1: runningShellTask('b1') }
  killTask('b1', setAppState)
  killTask('b1', setAppState)
  const sdk = drainSdkEvents().filter(event => event.subtype === 'task_notification')
  expect(sdk).toHaveLength(1)
  expect(sdk[0]).toMatchObject({
    task_id: 'b1',
    tool_use_id: 'toolu_bash',
    status: 'stopped',
    summary: 'sleep forever',
  })
  expect(state.tasks.b1).toMatchObject({ status: 'killed', notified: true })
})

test('stopTask on a bash task emits one stopped SDK event and suppresses the XML notification', async () => {
  state.tasks = { b2: runningShellTask('b2') }
  const result = await stopTask('b2', { getAppState, setAppState })
  expect(result).toEqual({ taskId: 'b2', taskType: 'local_bash', command: 'sleep 999' })
  const sdk = drainSdkEvents().filter(event => event.subtype === 'task_notification')
  expect(sdk).toHaveLength(1)
  expect(sdk[0]).toMatchObject({ task_id: 'b2', status: 'stopped', tool_use_id: 'toolu_bash' })
  expect(state.tasks.b2).toMatchObject({ status: 'killed', notified: true })
})
