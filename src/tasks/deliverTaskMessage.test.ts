import { expect, test } from 'bun:test'
import type { AppState } from '../state/AppState.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { deliverTaskMessage } from './deliverTaskMessage.js'

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

test('running agent: shown in its transcript and queued', () => {
  const s = setup({ a: agent('a', { status: 'running' }) })
  expect(deliverTaskMessage(s.get('a'), 'hi', s.setAppState)).toBe('queued')
  expect(s.get('a').pendingMessages).toEqual(['hi'])
  expect(s.get('a').messages).toHaveLength(1)
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
