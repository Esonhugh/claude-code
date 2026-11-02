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
  spawnDepth: 1,
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
  const started = events()
  const runId = (started[1] as { run_id?: string }).run_id
  expect(runId).toMatch(/^[0-9a-z]{9}-[0-9a-f]{8}$/)
  expect(started).toEqual([
    {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'a1', run_id: runId, task_type: 'local_agent', subagent_type: 'probe-agent', description: 'probe' }],
    },
    {
      type: 'system',
      subtype: 'task_started',
      task_id: 'a1',
      run_id: runId,
      tool_use_id: 'toolu_1',
      description: 'probe',
      subagent_type: 'probe-agent',
      is_backgrounded: true,
      spawn_depth: 1,
      task_type: 'local_agent',
      workflow_name: undefined,
      prompt: undefined,
    },
  ])

  updateTaskState<TaskState>('a1', setAppState, task => ({ ...task, status: 'completed', endTime: 5 }) as TaskState)
  expect(events()).toEqual([
    { type: 'system', subtype: 'task_updated', task_id: 'a1', run_id: runId, patch: { status: 'completed', end_time: 5 } },
  ])

  // Like official, the task leaves the background list once its notification is out.
  updateTaskState<TaskState>('a1', setAppState, task => ({ ...task, notified: true }) as TaskState)
  expect(events()).toEqual([{ type: 'system', subtype: 'background_tasks_changed', tasks: [] }])

  // Resuming the finished task opens a new run that sorts after the first.
  registerTask(agentTask, setAppState)
  const resumed = events().find(event => event.subtype === 'background_tasks_changed') as { tasks: { run_id: string }[] }
  expect(resumed.tasks[0]!.run_id > runId!).toBe(true)
})

test('subagent messages and task_progress name the subagent like official', async () => {
  const { normalizeMessage, normalizeSubagentMessage } = await import('../queryHelpers.js')
  const { createAssistantMessage, createUserMessage } = await import('../messages.js')
  const { emitTaskProgress } = await import('./sdkProgress.js')
  const agent = { agentId: 'a1', agentType: 'probe-agent', description: 'probe' }
  const named = { agent_id: 'a1', subagent_type: 'probe-agent', task_description: 'probe' }

  const assistant = createAssistantMessage({ content: 'hi' })
  expect([...normalizeSubagentMessage(assistant, 'toolu_1', agent)][0]).toMatchObject({
    type: 'assistant', parent_tool_use_id: 'toolu_1', ...named, timestamp: assistant.timestamp,
  })
  const user = createUserMessage({ content: 'result' })
  expect([...normalizeSubagentMessage(user, 'toolu_1', agent)][0]).toMatchObject({
    type: 'user', parent_tool_use_id: 'toolu_1', ...named,
  })
  // A foreground agent's messages arrive as agent_progress.
  const progress = {
    type: 'progress',
    toolUseID: 'agent_x',
    parentToolUseID: 'toolu_1',
    data: { type: 'agent_progress', message: assistant, prompt: '', agentId: 'a1', agentType: 'probe-agent', description: 'probe' },
    uuid: 'u1',
    timestamp: assistant.timestamp,
  }
  expect([...normalizeMessage(progress as never)][0]).toMatchObject(named)

  emitTaskProgress({ taskId: 'a1', toolUseId: 'toolu_1', description: 'Reading x', startTime: Date.now(), totalTokens: 1, toolUses: 1, subagentType: 'probe-agent' })
  expect(events()[0]).toMatchObject({ subtype: 'task_progress', subagent_type: 'probe-agent' })
})

test('a finished subagent sends task_notification, with its result text, before leaving background_tasks_changed', async () => {
  const { enqueueAgentNotification } = await import('../../tasks/LocalAgentTask/LocalAgentTask.js')
  registerTask(agentTask, setAppState)
  updateTaskState(agentTask.id, setAppState, task => ({ ...task, status: 'completed' }))
  drainSdkEvents()
  await enqueueAgentNotification({ taskId: 'a1', description: 'probe', status: 'completed', setAppState, finalMessage: 'FAKE_DONE', toolUseId: 'toolu_1' })
  await new Promise(resolve => setTimeout(resolve, 0))
  const events = drainSdkEvents().filter(e => e.subtype !== 'task_updated')
  expect(events.map(e => e.subtype)).toEqual(['task_notification', 'background_tasks_changed'])
  expect(events[0]).toMatchObject({ task_id: 'a1', tool_use_id: 'toolu_1', status: 'completed', summary: 'FAKE_DONE' })
  expect(events[1]).toMatchObject({ tasks: [] })
})
