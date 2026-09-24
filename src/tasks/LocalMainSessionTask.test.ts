import assert from 'node:assert/strict'
import { mock, test } from 'bun:test'
import type { QueryParams } from '../query.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import type { SetAppState } from '../Task.js'
import type { ToolUseContext } from '../Tool.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import type { Message } from '../types/message.js'
import { createUserMessage } from '../utils/messages.js'

type QueryCall = {
  params: QueryParams
  release: () => void
}

const queryCalls: QueryCall[] = []

mock.module('../query.js', () => ({
  async *query(params: QueryParams) {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    queryCalls.push({ params, release })
    await gate
    yield createUserMessage({ content: 'background reply' })
  },
}))
mock.module('../utils/cleanupRegistry.js', () => ({
  registerCleanup: () => () => {},
}))
mock.module('../utils/messageQueueManager.js', () => ({
  enqueuePendingNotification: () => {},
}))
mock.module('../utils/sdkEventQueue.js', () => ({
  emitTaskTerminatedSdk: () => {},
  enqueueSdkEvent: () => {},
}))
mock.module('../utils/sessionStorage.js', () => ({
  getAgentTranscriptPath: (agentId: string) => `/tmp/${agentId}.jsonl`,
  recordSidechainTranscript: async () => {},
}))
mock.module('../utils/task/diskOutput.js', () => ({
  evictTaskOutput: async () => {},
  getTaskOutputPath: (taskId: string) => `/tmp/${taskId}.output`,
  initTaskOutputAsSymlink: async () => {},
}))

const { startBackgroundSession } = await import('./LocalMainSessionTask.js')

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error('Timed out waiting for background session')
}

test('isolates background main query context and agent identity', async () => {
  let state: ReturnType<typeof getDefaultAppState> = {
    ...getDefaultAppState(),
    tasks: {},
  }
  const setAppState: SetAppState = updater => {
    state = updater(state)
  }

  const parentAbortController = new AbortController()
  const parentMessages: Message[] = [
    createUserMessage({ content: 'shared parent context' }),
  ]
  const parentToolUseContext = {
    abortController: parentAbortController,
    messages: parentMessages,
    options: { marker: 'parent-options' },
    agentId: undefined,
  } as unknown as ToolUseContext
  const queryParams = {
    systemPrompt: [],
    userContext: { source: 'parent' },
    systemContext: { session: 'parent' },
    canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
    toolUseContext: parentToolUseContext,
    querySource: 'repl',
    publicTurn: { text: 'foreground public turn' },
  } as unknown as Omit<QueryParams, 'messages'>
  const agentDefinition = {
    agentType: 'background-main-test',
    whenToUse: 'test',
    source: 'userSettings',
    getSystemPrompt: () => '',
  } as AgentDefinition

  const firstTaskId = startBackgroundSession({
    messages: parentMessages,
    queryParams,
    description: 'first background session',
    setAppState,
    agentDefinition,
  })
  const secondTaskId = startBackgroundSession({
    messages: parentMessages,
    queryParams,
    description: 'second background session',
    setAppState,
    agentDefinition,
  })

  await waitFor(() => queryCalls.length === 2)

  assert.notEqual(firstTaskId, secondTaskId)
  assert.equal(parentToolUseContext.agentId, undefined)
  assert.equal(queryParams.toolUseContext, parentToolUseContext)

  for (const [index, taskId] of [firstTaskId, secondTaskId].entries()) {
    const params = queryCalls[index]!.params
    assert.notEqual(params.toolUseContext, parentToolUseContext)
    assert.equal(params.toolUseContext.agentId, taskId)
    assert.equal(params.toolUseContext.abortController, parentAbortController)
    assert.equal(params.toolUseContext.options, parentToolUseContext.options)
    assert.equal(params.publicTurn, undefined)
    assert.notEqual(params.messages, parentMessages)
    assert.deepEqual(params.messages, parentMessages)

    const task = state.tasks[taskId]
    assert.equal(task?.type, 'local_agent')
    assert.equal(
      task?.description,
      `${index === 0 ? 'first' : 'second'} background session`,
    )
    if (task?.type === 'local_agent') {
      assert.equal(task.agentId, taskId)
      assert.equal(task.selectedAgent, agentDefinition)
      assert.equal(task.abortController?.signal.aborted, false)
    }
  }

  const firstTaskBeforeCancel = state.tasks[firstTaskId]
  assert.equal(firstTaskBeforeCancel?.type, 'local_agent')
  if (firstTaskBeforeCancel?.type === 'local_agent') {
    firstTaskBeforeCancel.abortController?.abort()
  }
  queryCalls[0]!.release()
  await waitFor(() => state.tasks[firstTaskId]?.notified === true)

  const firstTaskAfterCancel = state.tasks[firstTaskId]
  assert.equal(firstTaskAfterCancel?.status, 'running')
  assert.equal(firstTaskAfterCancel?.description, 'first background session')
  if (firstTaskAfterCancel?.type === 'local_agent') {
    assert.equal(firstTaskAfterCancel.agentId, firstTaskId)
    assert.equal(firstTaskAfterCancel.selectedAgent, agentDefinition)
    assert.equal(firstTaskAfterCancel.abortController?.signal.aborted, true)
    assert.equal(firstTaskAfterCancel.messages, undefined)
  }

  queryCalls[1]!.release()
  await waitFor(() => state.tasks[secondTaskId]?.status === 'completed')

  const secondTaskAfterCompletion = state.tasks[secondTaskId]
  assert.equal(secondTaskAfterCompletion?.description, 'second background session')
  if (secondTaskAfterCompletion?.type === 'local_agent') {
    assert.equal(secondTaskAfterCompletion.agentId, secondTaskId)
    assert.equal(secondTaskAfterCompletion.selectedAgent, agentDefinition)
    assert.equal(secondTaskAfterCompletion.abortController?.signal.aborted, false)
  }
  assert.equal(parentToolUseContext.agentId, undefined)
  assert.equal(parentToolUseContext.abortController, parentAbortController)
  assert.equal(parentToolUseContext.messages, parentMessages)
})
