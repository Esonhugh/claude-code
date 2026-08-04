import assert from 'node:assert/strict'

import { getDefaultAppState } from './AppStateStore.js'
import { canEvictTerminalTask } from '../utils/task/retention.js'
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
      messages: [],
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

exitTeammateView(setState)
assert.equal(state.viewingAgentTaskId, undefined)
assert.equal(state.tasks['teammate-1'], undefined)

console.log('teammateViewHelpers.test.ts passed')
