import assert from 'node:assert/strict'

import { getDefaultAppState } from './AppStateStore.js'
import { canEvictTerminalTask } from '../utils/task/retention.js'
import { applyTaskOffsetsAndEvictions, evictTerminalTask, generateTaskAttachments, PANEL_GRACE_MS } from '../utils/task/framework.js'
import { createUserMessage } from '../utils/messages.js'
import { enterTeammateView, exitTeammateView } from './teammateViewHelpers.js'

let state = getDefaultAppState()
state = {
  ...state,
  tasks: {
    'teammate-1': {
      id: 'teammate-1',
      type: 'in_process_teammate',
      status: 'completed',
      description: 'Inspect coordinator state',
      prompt: 'Inspect coordinator state',
      startTime: 1,
      endTime: 2,
      outputFile: '.claude/tasks/teammate-1.output',
      outputOffset: 0,
      notified: true,
      messages: [createUserMessage({ content: 'Retained transcript' })],
      identity: {
        agentId: 'teammate-1@test-team',
        agentName: 'teammate-1',
        teamName: 'test-team',
        color: 'blue',
        planModeRequired: false,
        parentSessionId: 'session-1',
      },
      permissionMode: 'default',
      awaitingPlanApproval: false,
      pendingUserMessages: [],
      isIdle: true,
      shutdownRequested: false,
      lastReportedToolCount: 0,
      lastReportedTokenCount: 0,
    },
  },
}
const setState = (updater: (prev: typeof state) => typeof state): void => {
  state = updater(state)
}

const teammate = state.tasks['teammate-1']!
assert.equal(teammate.type, 'in_process_teammate')
if (teammate.type !== 'in_process_teammate') throw new Error('Expected teammate')
const transcript = teammate.messages
state.tasks['teammate-1'] = { ...teammate, status: 'running', endTime: undefined }
enterTeammateView('teammate-1', setState)
exitTeammateView(setState)
assert.equal(state.tasks['teammate-1']?.status, 'running')
assert.equal(state.tasks['teammate-1']?.retain, undefined)
assert.equal(canEvictTerminalTask(state.tasks['teammate-1']!), false)
enterTeammateView('teammate-1', setState)
assert.equal(state.tasks['teammate-1']?.type, 'in_process_teammate')
assert.equal((state.tasks['teammate-1'] as typeof teammate).isIdle, true)
assert.equal((state.tasks['teammate-1'] as typeof teammate).messages, transcript)
exitTeammateView(setState)

state.tasks['teammate-1'] = teammate
enterTeammateView('teammate-1', setState)
const viewedTask = state.tasks['teammate-1']
assert.equal(state.viewingAgentTaskId, 'teammate-1')
assert.equal(viewedTask?.type, 'in_process_teammate')
assert.equal(viewedTask?.retain, true)
assert.equal(
  canEvictTerminalTask({
    ...viewedTask,
    id: 'teammate-1',
    viewingAgentTaskId: state.viewingAgentTaskId,
  }),
  false,
)

const originalNow = Date.now
let now = 100_000
Date.now = () => now
try {
  exitTeammateView(setState)
  assert.equal(state.viewingAgentTaskId, undefined)
  const released = state.tasks['teammate-1'] as typeof teammate
  assert.ok(released, 'completed transcript must survive exit')
  assert.equal(released.status, 'completed')
  assert.equal(released.messages, transcript)
  assert.equal(canEvictTerminalTask(released, now + PANEL_GRACE_MS - 1), false)
  assert.equal(canEvictTerminalTask(released, now + PANEL_GRACE_MS), true)
  evictTerminalTask('teammate-1', setState)
  assert.equal(state.tasks['teammate-1'], released)

  now += PANEL_GRACE_MS - 1
  enterTeammateView('teammate-1', setState)
  now += PANEL_GRACE_MS
  assert.equal(canEvictTerminalTask(state.tasks['teammate-1']!), false)
  assert.equal((state.tasks['teammate-1'] as typeof teammate).messages, transcript)

  state.tasks['teammate-2'] = { ...teammate, id: 'teammate-2' }
  enterTeammateView('teammate-2', setState)
  assert.equal(state.tasks['teammate-1']?.status, 'completed')
  assert.equal(canEvictTerminalTask(state.tasks['teammate-1']!), false)
  enterTeammateView('teammate-1', setState)
  assert.equal((state.tasks['teammate-1'] as typeof teammate).messages, transcript)
  exitTeammateView(setState)

  now += PANEL_GRACE_MS
  const { evictedTaskIds } = await generateTaskAttachments(state)
  assert.deepEqual(evictedTaskIds.sort(), ['teammate-1', 'teammate-2'])
  // Reopening between the GC snapshot and apply must prevent stale eviction.
  enterTeammateView('teammate-1', setState)
  applyTaskOffsetsAndEvictions(setState, {}, evictedTaskIds)
  assert.ok(state.tasks['teammate-1'])
  assert.equal(state.tasks['teammate-2'], undefined)
  exitTeammateView(setState)
  now += PANEL_GRACE_MS
  evictTerminalTask('teammate-1', setState)
  assert.equal(state.tasks['teammate-1'], undefined)
} finally {
  Date.now = originalNow
}

console.log('teammateViewHelpers.test.ts passed')
