import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getIsNonInteractiveSession, setIsInteractive } from '../../bootstrap/state.js'
import { onChangeAppState } from '../../state/onChangeAppState.js'
import { getDefaultAppState, type AppState } from '../../state/AppStateStore.js'
import type { TaskState } from '../../tasks/types.js'
import { drainSdkEvents } from '../sdkEventQueue.js'
import { registerTask, updateTaskState } from './framework.js'

let state: AppState
const wasInteractive = !getIsNonInteractiveSession()
const setAppState = (updater: (prev: AppState) => AppState) => {
  const oldState = state
  state = updater(state)
  if (state !== oldState) onChangeAppState({ newState: state, oldState })
}

const agentTask = {
  id: 'a1',
  type: 'local_agent',
  status: 'running',
  description: 'probe',
  agentType: 'probe-agent',
  toolUseId: 'toolu_1',
  isBackgrounded: true,
  startTime: 1,
  outputFile: '',
  outputOffset: 0,
  notified: false,
} as unknown as TaskState

beforeEach(() => {
  setIsInteractive(false)
  state = getDefaultAppState()
  drainSdkEvents()
})
afterEach(() => {
  drainSdkEvents()
  setIsInteractive(wasInteractive)
})

const events = () =>
  drainSdkEvents().map(({ uuid: _uuid, session_id: _session, ...event }) => event)

test('a background agent reports task_started, task_updated and background_tasks_changed', () => {
  registerTask(agentTask, setAppState)
  expect(events()).toEqual([
    {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'a1', task_type: 'local_agent', subagent_type: 'probe-agent', description: 'probe' }],
    },
    {
      type: 'system',
      subtype: 'task_started',
      task_id: 'a1',
      tool_use_id: 'toolu_1',
      description: 'probe',
      subagent_type: 'probe-agent',
      is_backgrounded: true,
      task_type: 'local_agent',
      workflow_name: undefined,
      prompt: undefined,
    },
  ])

  updateTaskState<TaskState>('a1', setAppState, task => ({ ...task, status: 'completed', endTime: 5 }) as TaskState)
  expect(events()).toEqual([
    { type: 'system', subtype: 'task_updated', task_id: 'a1', patch: { status: 'completed', end_time: 5 } },
  ])

  // Like official, the task leaves the background list once its notification is out.
  updateTaskState<TaskState>('a1', setAppState, task => ({ ...task, notified: true }) as TaskState)
  expect(events()).toEqual([{ type: 'system', subtype: 'background_tasks_changed', tasks: [] }])
})
