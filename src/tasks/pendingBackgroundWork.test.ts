import { expect, test } from 'bun:test'
import { countPendingBackgroundWork, turnDurationAfterBackgroundWait } from './pendingBackgroundWork.js'
import type { TaskState } from './types.js'

const agent = (id: string, status: string, extra: Record<string, unknown> = {}) =>
  ({ id, type: 'local_agent', status, isBackgrounded: true, notified: false, ...extra }) as unknown as TaskState

test('counts running, unreported and queued background agents and workflows', () => {
  const tasks = {
    running: agent('running', 'running'),
    unreported: agent('unreported', 'completed'),
    reported: agent('reported', 'completed', { notified: true }),
    queued: agent('queued', 'completed', { notified: true }),
    foreground: agent('foreground', 'running', { isBackgrounded: false }),
    shell: { id: 'shell', type: 'local_bash', status: 'running', notified: false } as unknown as TaskState,
    flow: { id: 'flow', type: 'local_workflow', status: 'running', notified: false } as unknown as TaskState,
  }
  const queuedCommands = [
    { mode: 'task-notification', value: '', taskId: 'queued' },
    { mode: 'task-notification', value: '', taskId: 'reported', agentId: 'owner' },
  ] as never
  expect(countPendingBackgroundWork({ tasks, queuedCommands })).toEqual({ pendingAgents: 3, pendingWorkflows: 1 })
})

test('a turn after a background wait reports the time since the waiting turn started', () => {
  const waiting = turnDurationAfterBackgroundWait({
    tasks: { a: agent('a', 'running') },
    turnDurationMs: 300,
    turnStartTime: 1_000,
    now: 1_300,
    backgroundWaitStartTime: null,
  })
  expect(waiting).toEqual({ durationMs: 300, pendingBackgroundAgentCount: 1, pendingWorkflowCount: undefined, backgroundWaitStartTime: 1_000 })
  expect(turnDurationAfterBackgroundWait({
    tasks: { a: agent('a', 'completed', { notified: true }) },
    turnDurationMs: 200,
    turnStartTime: 5_000,
    now: 5_200,
    backgroundWaitStartTime: waiting.backgroundWaitStartTime,
  })).toEqual({ durationMs: 4_200, backgroundWaitStartTime: null })
})
