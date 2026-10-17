import assert from 'node:assert/strict'
import { afterEach, test } from 'bun:test'

import { getDefaultAppState, type AppState } from '../../state/AppState.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { AgentId } from '../../types/ids.js'
import * as messageQueue from '../../utils/messageQueueManager.js'
import { killShellTasksForAgent } from './killShellTasks.js'

afterEach(() => {
  messageQueue.resetCommandQueue()
})

test('an exiting agent keeps the queued notifications of the child agents it owns', () => {
  messageQueue.resetCommandQueue()
  let state = {
    ...getDefaultAppState(),
    tasks: {
      child: { id: 'child', type: 'local_agent', status: 'completed', notified: true, ownerAgentId: 'owner' },
      stranger: { id: 'stranger', type: 'local_agent', status: 'completed', notified: true, ownerAgentId: 'someone-else' },
    },
    toolPermissionContext: getEmptyToolPermissionContext(),
  } as unknown as AppState
  const setAppState = (fn: (prev: AppState) => AppState) => {
    state = fn(state)
  }
  messageQueue.enqueuePendingNotification({ value: 'shell done', mode: 'task-notification', agentId: 'owner' as AgentId })
  messageQueue.enqueuePendingNotification({ value: 'child done', mode: 'task-notification', agentId: 'owner' as AgentId, taskId: 'child' })
  messageQueue.enqueuePendingNotification({ value: 'misaddressed', mode: 'task-notification', agentId: 'owner' as AgentId, taskId: 'stranger' })

  killShellTasksForAgent('owner' as AgentId, () => state, setAppState)

  // The owner's parking hand-off delivers the child's result after its run ends.
  assert.deepEqual(messageQueue.getCommandQueue().map(command => command.value), ['child done'])
})
