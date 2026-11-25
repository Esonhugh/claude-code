import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  addToTotalCostState,
  getIsNonInteractiveSession,
  getSessionId,
  getTotalCostUSD,
  setIsInteractive,
} from '../../bootstrap/state.js'
import { getDefaultAppState, type AppState } from '../../state/AppStateStore.js'
import type { ModelUsage } from '../../entrypoints/agentSdkTypes.js'
import type { TaskState } from '../../tasks/types.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import {
  enqueue,
  getCommandQueueSnapshot,
  resetCommandQueue,
} from '../../utils/messageQueueManager.js'
import { drainSdkOutput } from '../../utils/sdkEventQueue.js'
import { clearConversation } from './conversation.js'

let state: AppState
const wasInteractive = !getIsNonInteractiveSession()
const context = () => ({
  setMessages: () => {},
  readFileState: createFileStateCacheWithSizeLimit(10),
  getAppState: () => state,
  setAppState: (updater: (prev: AppState) => AppState) => {
    state = updater(state)
  },
})

beforeEach(() => {
  state = getDefaultAppState()
  drainSdkOutput()
})
afterEach(() => {
  drainSdkOutput()
  setIsInteractive(wasInteractive)
})

test('headless /clear tells SDK hosts which session it left and what still runs, like 2.1.329', async () => {
  setIsInteractive(false)
  const backgroundAgent = {
    id: 'a1',
    type: 'local_agent',
    status: 'running',
    description: 'probe',
    agentType: 'probe-agent',
    agentId: 'a1',
    isBackgrounded: true,
    notified: false,
  } as unknown as TaskState
  state = { ...state, tasks: { a1: backgroundAgent } }
  addToTotalCostState(0.5, {} as ModelUsage, 'claude-test')
  const leftSession = getSessionId()

  await clearConversation({ ...context(), resetUserMessageUuid: 'user-uuid-1' })

  expect(getSessionId()).not.toBe(leftSession)
  expect(getTotalCostUSD()).toBe(0)
  const [reset, tasks, ...rest] = drainSdkOutput() as Array<Record<string, unknown>>
  expect(reset).toEqual({
    type: 'conversation_reset',
    new_conversation_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    uuid: reset!.new_conversation_id,
    trigger: 'clear',
    user_message_uuid: 'user-uuid-1',
    timestamp: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/),
    session_id: leftSession,
  })
  expect(reset!.new_conversation_id).not.toBe(getSessionId())
  expect(tasks).toEqual({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'a1', task_type: 'local_agent', subagent_type: 'probe-agent', description: 'probe' }],
    uuid: expect.any(String),
    session_id: leftSession,
  })
  expect(rest).toEqual([])
})

test('interactive /clear sends no conversation_reset', async () => {
  setIsInteractive(true)
  await clearConversation(context())
  expect(drainSdkOutput()).toEqual([])
})

test('/clear drops the stop notices the next turn would take, and keeps the rest', async () => {
  resetCommandQueue()
  enqueue({ value: 'stopped', mode: 'task-notification', passive: true })
  enqueue({ value: 'done', mode: 'task-notification' })
  enqueue({ value: 'sub', mode: 'task-notification', passive: true, agentId: 'a1' as never })

  await clearConversation(context())

  expect(getCommandQueueSnapshot().map(cmd => cmd.value)).toEqual(['done', 'sub'])
  resetCommandQueue()
})
