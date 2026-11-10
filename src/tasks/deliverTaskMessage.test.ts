import { expect, test } from 'bun:test'
import type { AppState } from '../state/AppState.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { deliverTaskMessage, queuedUserMessages } from './deliverTaskMessage.js'

const base = { description: 'd', startTime: 0, outputFile: '/dev/null', outputOffset: 0, notified: false }

function setup(tasks: Record<string, unknown>) {
  let state: AppState = { ...getDefaultAppState(), tasks: tasks as AppState['tasks'] }
  const setAppState = (update: (prev: AppState) => AppState) => {
    state = update(state)
  }
  return { get: (id: string) => state.tasks[id] as any, setAppState }
}

const agent = (id: string, extra: Record<string, unknown>) =>
  ({ ...base, id, type: 'local_agent', agentId: id, prompt: 'p', messages: [], pendingMessages: [], ...extra })
const teammate = (id: string, status: string) =>
  ({ ...base, id, type: 'in_process_teammate', status, messages: [], pendingUserMessages: [] })

test('running agent: queued, and shown from the queue until the agent reads it', () => {
  const s = setup({ a: agent('a', { status: 'running' }) })
  expect(deliverTaskMessage(s.get('a'), 'hi', s.setAppState)).toBe('queued')
  // Typed by the user, not sent by the parent: the agent must not see it as a coordinator message.
  expect(s.get('a').pendingMessages).toEqual([{ text: 'hi', fromUser: true }])
  expect(queuedUserMessages(s.get('a')).map(m => m.message.content)).toEqual(['hi'])
})

test('ended agent: shown in its transcript, caller resumes it', () => {
  const s = setup({ a: agent('a', { status: 'completed' }) })
  expect(deliverTaskMessage(s.get('a'), 'hi', s.setAppState)).toBe('resume')
  expect(s.get('a').messages).toHaveLength(1)
  expect(s.get('a').pendingMessages).toEqual([])
})

test('agent stopped by the user: refused before anything is shown', () => {
  const s = setup({ a: agent('a', { status: 'killed', stoppedByUser: true }) })
  expect(() => deliverTaskMessage(s.get('a'), 'hi', s.setAppState)).toThrow('agent a was stopped by the user')
  expect(s.get('a').messages).toEqual([])
})

test('teammates: running gets the message, stopped refuses', () => {
  const s = setup({ t1: teammate('t1', 'running'), t2: teammate('t2', 'completed') })
  expect(deliverTaskMessage(s.get('t1'), 'hi', s.setAppState)).toBe('injected')
  expect(s.get('t1').pendingUserMessages).toEqual(['hi'])
  expect(() => deliverTaskMessage(s.get('t2'), 'hi', s.setAppState)).toThrow('teammate has stopped; message was not sent')
  expect(() => deliverTaskMessage(undefined, 'hi', s.setAppState)).toThrow('no agent or teammate task')
})

test('a running agent sees a typed message as the user\'s and a parent message as the coordinator\'s', async () => {
  const { getAgentPendingMessageAttachments } = await import('../utils/attachments.js')
  const s = setup({ a: agent('a', { status: 'running', pendingMessages: ['from parent'] }) })
  deliverTaskMessage(s.get('a'), 'from user', s.setAppState)
  let state = { tasks: { a: s.get('a') } } as unknown as AppState
  const context = { agentId: 'a', getAppState: () => state, setAppState: (f: (p: AppState) => AppState) => { state = f(state) } }
  expect(getAgentPendingMessageAttachments(context as never)).toEqual([
    { type: 'queued_command', prompt: 'from parent', origin: { kind: 'coordinator' }, isMeta: true },
    { type: 'queued_command', prompt: 'from user', origin: { kind: 'human' } },
  ])
})

test('a message queued for a running agent survives switching the view away and back', async () => {
  const { enterTeammateView, exitTeammateView } = await import('../state/teammateViewHelpers.js')
  const s = setup({ a: agent('a', { status: 'running' }) })
  enterTeammateView('a', s.setAppState)
  deliverTaskMessage(s.get('a'), 'hi', s.setAppState)
  // Shown once while queued: the drained copy is what the transcript records.
  expect(s.get('a').messages).toEqual([])
  exitTeammateView(s.setAppState)
  enterTeammateView('a', s.setAppState)
  expect(queuedUserMessages(s.get('a')).map(m => m.message.content)).toEqual(['hi'])
})
