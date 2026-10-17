import { expect, test } from 'bun:test'
import { createTaskStateBase } from '../Task.js'
import type { InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js'
import type { TaskState } from '../tasks/types.js'
import { PANEL_GRACE_MS } from '../utils/task/framework.js'
import { canEvictTerminalTask } from '../utils/task/retention.js'
import { completeTeammateTasksOnShutdown } from '../utils/swarm/teammateShutdown.js'

function teammateTask(
  id: string,
  agentId: string,
  status: InProcessTeammateTaskState['status'] = 'running',
): InProcessTeammateTaskState {
  const [agentName = '', teamName = ''] = agentId.split('@')
  return {
    ...createTaskStateBase(id, 'in_process_teammate', agentName, `toolu_${id}`),
    type: 'in_process_teammate',
    status,
    identity: { agentId, agentName, teamName, planModeRequired: false, parentSessionId: 'session' },
    prompt: 'inspect only',
    awaitingPlanApproval: false,
    permissionMode: 'default',
    pendingUserMessages: [],
    isIdle: false,
    shutdownRequested: true,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
  }
}

test('shutdown approval leaves the teammate task notified and evictable after the panel grace period', () => {
  const running = teammateTask('t1', 'researcher@team')
  const killed = { ...teammateTask('t2', 'researcher@team', 'killed'), notified: true, endTime: 1 }
  const other = teammateTask('t3', 'writer@team')
  const tasks: Record<string, TaskState> = { t1: running, t2: killed, t3: other }
  const now = 1_000_000

  const { tasks: updated, shutDown } = completeTeammateTasksOnShutdown(tasks, 'researcher@team', now)

  expect(shutDown.map(task => task.id)).toEqual(['t1'])
  expect(updated.t1).toMatchObject({
    status: 'completed',
    notified: true,
    endTime: now,
    retain: false,
    evictAfter: now + PANEL_GRACE_MS,
  })
  expect(canEvictTerminalTask(updated.t1!, now + PANEL_GRACE_MS - 1)).toBe(false)
  expect(canEvictTerminalTask(updated.t1!, now + PANEL_GRACE_MS)).toBe(true)
  // Already-terminal and unrelated tasks are untouched; the input map is not mutated.
  expect(updated.t2).toBe(killed)
  expect(updated.t3).toBe(other)
  expect(tasks.t1).toBe(running)
})
