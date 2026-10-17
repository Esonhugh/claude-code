import assert from 'node:assert/strict'

import { canEvictTerminalTask } from './retention.js'

// Workflows stay for PANEL_GRACE_MS after their terminal transition.
assert.equal(canEvictTerminalTask({
  type: 'local_workflow',
  status: 'completed',
  notified: true,
  evictAfter: 200,
}, 100), false)

assert.equal(canEvictTerminalTask({
  type: 'local_workflow',
  status: 'completed',
  notified: true,
  evictAfter: 100,
}, 100), true)

assert.equal(canEvictTerminalTask({
  type: 'local_workflow',
  status: 'failed',
  notified: true,
}, 100), true)

assert.equal(canEvictTerminalTask({
  type: 'local_workflow',
  status: 'killed',
  notified: false,
  evictAfter: 50,
}, 100), false)

assert.equal(canEvictTerminalTask({
  type: 'local_workflow',
  status: 'pending',
  notified: true,
  evictAfter: 50,
}, 100), false)

// retain:false alone keeps the task until an evictAfter deadline passes.
assert.equal(canEvictTerminalTask({
  type: 'local_agent',
  status: 'completed',
  notified: true,
  retain: false,
}, 100), false)

assert.equal(canEvictTerminalTask({
  type: 'local_agent',
  status: 'completed',
  notified: true,
  retain: false,
  evictAfter: 100,
}, 100), true)

assert.equal(canEvictTerminalTask({
  type: 'local_bash',
  status: 'completed',
  notified: true,
}), true)

assert.equal(canEvictTerminalTask({
  type: 'local_agent',
  status: 'completed',
  notified: true,
  retain: true,
  evictAfter: 200,
}, 100), false)

assert.equal(canEvictTerminalTask({
  type: 'local_agent',
  status: 'completed',
  notified: true,
  retain: true,
  evictAfter: 50,
}, 100), true)

assert.equal(canEvictTerminalTask({
  id: 'teammate-1',
  viewingAgentTaskId: 'teammate-1',
  type: 'in_process_teammate',
  status: 'completed',
  notified: true,
  retain: true,
}, 100), false)

assert.equal(canEvictTerminalTask({
  id: 'teammate-1',
  viewingAgentTaskId: 'another-task',
  type: 'in_process_teammate',
  status: 'completed',
  notified: true,
  retain: true,
}, 100), false)

assert.equal(canEvictTerminalTask({
  id: 'teammate-1',
  viewingAgentTaskId: 'another-task',
  type: 'in_process_teammate',
  status: 'completed',
  notified: true,
}, 100), true)

console.log('retention.test.ts passed')
