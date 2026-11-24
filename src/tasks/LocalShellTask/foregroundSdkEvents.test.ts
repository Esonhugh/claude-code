import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getIsNonInteractiveSession, setIsInteractive } from '../../bootstrap/state.js'
import { onChangeAppState } from '../../state/onChangeAppState.js'
import { getDefaultAppState, type AppState } from '../../state/AppStateStore.js'
import { getCommandQueue, resetCommandQueue } from '../../utils/messageQueueManager.js'
import { drainSdkEvents } from '../../utils/sdkEventQueue.js'
import type { ExecResult, ShellCommand } from '../../utils/ShellCommand.js'
import { backgroundTaskForToolUse, registerForeground, unregisterForeground } from './LocalShellTask.js'

let state: AppState
const wasInteractive = !getIsNonInteractiveSession()
const setAppState = (updater: (prev: AppState) => AppState) => {
  const oldState = state
  state = updater(state)
  if (state !== oldState) onChangeAppState({ newState: state, oldState })
}

beforeEach(() => {
  setIsInteractive(false)
  state = getDefaultAppState()
  resetCommandQueue()
  drainSdkEvents()
})
afterEach(() => {
  resetCommandQueue()
  drainSdkEvents()
  setIsInteractive(wasInteractive)
})

// What SDK hosts are sent, without the ids that differ per run.
const events = () =>
  drainSdkEvents().map(({ uuid: _uuid, session_id: _session, ...event }) => {
    const { run_id: _run, ...rest } = event as { run_id?: string }
    return rest
  })

function foreground(taskId: string) {
  const result = Promise.withResolvers<ExecResult>()
  const shellCommand = {
    status: 'running',
    result: result.promise,
    taskOutput: { taskId, flush: async () => {} },
    background: () => true,
    cleanup: () => {},
    kill: () => {},
  } as unknown as ShellCommand
  registerForeground({ command: 'make test', description: 'Run the tests', shellCommand }, setAppState, 'toolu_1')
  return result
}

test('a command registered in the foreground is announced as not backgrounded', () => {
  foreground('b1')
  expect(events()).toEqual([
    {
      type: 'system',
      subtype: 'task_started',
      task_id: 'b1',
      tool_use_id: 'toolu_1',
      description: 'Run the tests',
      is_backgrounded: false,
      task_type: 'local_bash',
      workflow_name: undefined,
      prompt: undefined,
    },
  ])
})

test('a foreground command that ends is closed with the status it ended with', () => {
  foreground('b2')
  events()
  unregisterForeground('b2', setAppState, 'failed')
  expect(state.tasks.b2).toBeUndefined()
  expect(events()).toEqual([
    {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'b2',
      tool_use_id: 'toolu_1',
      status: 'failed',
      output_file: '',
      summary: 'Run the tests',
      usage: undefined,
    },
  ])
  // Nothing is left to close a second time.
  unregisterForeground('b2', setAppState, 'failed')
  expect(events()).toEqual([])
})

test('moving it to the background is a task_updated, and its end is told before it leaves the list', async () => {
  const result = foreground('b3')
  events()
  expect(backgroundTaskForToolUse('toolu_1', () => state, setAppState)).toBe(true)
  expect(events()).toEqual([
    {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [expect.objectContaining({ task_id: 'b3', task_type: 'local_bash', description: 'Run the tests' })],
    },
    { type: 'system', subtype: 'task_updated', task_id: 'b3', patch: { is_backgrounded: true } },
  ])

  result.resolve({ code: 0, interrupted: false, stdout: '', stderr: '' } as ExecResult)
  await Bun.sleep(20)
  expect(events().map(event => (event as { subtype: string }).subtype)).toEqual([
    'task_updated',
    'task_notification',
    'background_tasks_changed',
  ])
  // The model is still told, without SDK hosts being told again.
  expect(getCommandQueue().map(command => [command.mode, command.sdkTaskNotificationSent])).toEqual([
    ['task-notification', true],
  ])
})
