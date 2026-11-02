import { expect, test } from 'bun:test'
import type { InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js'
import { PANEL_GRACE_MS } from '../utils/task/framework.js'
import type { AppState } from './AppState.js'
import { getDefaultAppState } from './AppStateStore.js'
import { hideIdleTeammates } from './teammateViewHelpers.js'

function teammate(id: string, overrides: Partial<InProcessTeammateTaskState> = {}): InProcessTeammateTaskState {
  return {
    id, type: 'in_process_teammate', status: 'running', description: id, prompt: id,
    startTime: 1, outputFile: '', outputOffset: 0, notified: false,
    identity: { agentId: id, agentName: id, teamName: 'team', color: 'blue', planModeRequired: false, parentSessionId: 's' },
    awaitingPlanApproval: false, permissionMode: 'default', pendingUserMessages: [],
    isIdle: true, shutdownRequested: false, lastReportedToolCount: 0, lastReportedTokenCount: 0,
    ...overrides,
  } as InProcessTeammateTaskState
}

function run(tasks: Record<string, object>, now: number): Record<string, InProcessTeammateTaskState> {
  let state: AppState = { ...getDefaultAppState(), tasks: tasks as unknown as AppState['tasks'] }
  hideIdleTeammates(updater => { state = updater(state) }, now)
  return state.tasks as unknown as Record<string, InProcessTeammateTaskState>
}

const NOW = 1_000_000

test('an idle teammate is hidden once its grace period has passed, but stays running', () => {
  const tasks = run({ a: teammate('a', { evictAfter: NOW - 1 }), b: teammate('b', { evictAfter: NOW + 1 }) }, NOW)
  expect(tasks.a).toMatchObject({ status: 'running', isIdle: true, evictAfter: 0 })
  expect(tasks.b!.evictAfter).toBe(NOW + 1)
})

test('while another agent or teammate is busy the idle teammate keeps its row', () => {
  const agent = { id: 'agent', type: 'local_agent', status: 'running', agentType: 'Explore', startTime: 1 }
  expect(run({ a: teammate('a', { evictAfter: NOW - 1 }), agent }, NOW).a!.evictAfter).toBe(NOW + PANEL_GRACE_MS)
  const working = teammate('working', { evictAfter: NOW - 1, isIdle: false })
  const tasks = run({ a: teammate('a', { evictAfter: NOW - 1 }), working }, NOW)
  expect(tasks.a!.evictAfter).toBe(NOW + PANEL_GRACE_MS)
  expect(tasks.working).toBe(working)
})

test('queued messages, plan approval and the viewed teammate are never hidden', () => {
  const tasks = run(
    {
      queued: teammate('queued', { evictAfter: NOW - 1, pendingUserMessages: ['hi'] }),
      plan: teammate('plan', { evictAfter: NOW - 1, awaitingPlanApproval: true }),
      done: teammate('done', { evictAfter: NOW - 1, status: 'completed' }),
    },
    NOW,
  )
  expect(Object.values(tasks).map(task => task.evictAfter)).toEqual([NOW - 1, NOW - 1, NOW - 1])
  let state: AppState = {
    ...getDefaultAppState(),
    viewingAgentTaskId: 'a',
    tasks: { a: teammate('a', { evictAfter: NOW - 1 }) } as unknown as AppState['tasks'],
  }
  const before = state
  hideIdleTeammates(updater => { state = updater(state) }, NOW)
  expect(state).toBe(before)
})
