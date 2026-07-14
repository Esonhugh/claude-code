import assert from 'node:assert/strict'

import { getEmptyToolPermissionContext } from '../../Tool.js'
import { getDefaultAppState, type AppState } from '../../state/AppState.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import {
  createProgressTracker,
  enqueueAgentNotification,
  getProgressUpdate,
  publishAgentProgress,
  refreshLastAssistantProgress,
  registerAgentForeground,
  updateProgressFromMessage,
} from './LocalAgentTask.js'
import {
  getCommandQueue,
  resetCommandQueue,
} from '../../utils/messageQueueManager.js'

const assistantMessage = ({
  uuid,
  inputTokens,
  outputTokens,
  toolUseId,
  toolName = 'Read',
  cacheCreationInputTokens,
  cacheReadInputTokens,
}: {
  uuid: string
  inputTokens: number
  outputTokens: number
  toolUseId?: string
  toolName?: string
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
}): AssistantMessage => ({
  type: 'assistant',
  uuid: uuid as Message['uuid'],
  timestamp: '2026-07-11T00:00:00.000Z',
  message: {
    id: `msg-${uuid}`,
    role: 'assistant',
    model: 'claude-test',
    content: [
      {
        type: 'tool_use',
        ...(toolUseId ? { id: toolUseId } : {}),
        name: toolName,
        input: { file_path: 'src/index.ts' },
      },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      ...(cacheCreationInputTokens !== undefined
        ? { cache_creation_input_tokens: cacheCreationInputTokens }
        : {}),
      ...(cacheReadInputTokens !== undefined
        ? { cache_read_input_tokens: cacheReadInputTokens }
        : {}),
    },
  },
})

const tracker = createProgressTracker()
const first = assistantMessage({
  uuid: '00000000-0000-4000-8000-000000000001',
  inputTokens: 100,
  outputTokens: 10,
  toolUseId: 'toolu_1',
})
const second = assistantMessage({
  uuid: '00000000-0000-4000-8000-000000000002',
  inputTokens: 120,
  outputTokens: 20,
  toolUseId: 'toolu_2',
})

updateProgressFromMessage(tracker, first)
updateProgressFromMessage(tracker, first)
updateProgressFromMessage(tracker, second)
updateProgressFromMessage(tracker, {
  ...second,
  message: {
    ...second.message,
    content: [
      ...(second.message.content ?? []),
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Bash',
        input: { command: 'pwd' },
      },
      {
        type: 'tool_use',
        id: 'toolu_structured',
        name: 'StructuredOutput',
        input: { result: 'ok' },
      },
    ],
  },
})

const progress = getProgressUpdate(tracker)

assert.equal(progress.tokenCount, 140)
assert.equal(progress.toolUseCount, 3)
assert.deepEqual(
  progress.recentActivities?.map(activity => activity.toolName),
  ['Read', 'Read'],
)

const mutationTracker = createProgressTracker()
const mutable = assistantMessage({
  uuid: '00000000-0000-4000-8000-000000000003',
  inputTokens: 0,
  outputTokens: 0,
  toolUseId: 'toolu_mutable_1',
})
updateProgressFromMessage(mutationTracker, mutable)
mutable.message.usage.input_tokens = 200
mutable.message.usage.cache_creation_input_tokens = 30
mutable.message.usage.cache_read_input_tokens = 20
mutable.message.usage.output_tokens = 40
updateProgressFromMessage(mutationTracker, mutable)
updateProgressFromMessage(mutationTracker, mutable)

assert.equal(getProgressUpdate(mutationTracker).tokenCount, 290)
assert.equal(getProgressUpdate(mutationTracker).toolUseCount, 1)

const noIdTracker = createProgressTracker()
const noIdMessage = assistantMessage({
  uuid: '00000000-0000-4000-8000-000000000004',
  inputTokens: 10,
  outputTokens: 5,
})
updateProgressFromMessage(noIdTracker, noIdMessage)
updateProgressFromMessage(noIdTracker, noIdMessage)

assert.equal(getProgressUpdate(noIdTracker).toolUseCount, 1)
assert.deepEqual(
  getProgressUpdate(noIdTracker).recentActivities?.map(activity => activity.toolName),
  ['Read'],
)

const replayTracker = createProgressTracker()
const replayFirst = assistantMessage({
  uuid: '00000000-0000-4000-8000-000000000005',
  inputTokens: 0,
  outputTokens: 0,
  toolUseId: 'toolu_replay_1',
})
const replaySecond = assistantMessage({
  uuid: '00000000-0000-4000-8000-000000000006',
  inputTokens: 150,
  outputTokens: 5,
  toolUseId: 'toolu_replay_2',
})
updateProgressFromMessage(replayTracker, replayFirst)
replayFirst.message.usage.input_tokens = 120
replayFirst.message.usage.output_tokens = 8
for (const message of [replayFirst, replaySecond]) {
  updateProgressFromMessage(replayTracker, message)
}
for (const message of [replayFirst, replaySecond]) {
  updateProgressFromMessage(replayTracker, message)
}
assert.equal(getProgressUpdate(replayTracker).tokenCount, 155)
assert.equal(getProgressUpdate(replayTracker).toolUseCount, 2)

const compactedTracker = createProgressTracker()
updateProgressFromMessage(
  compactedTracker,
  assistantMessage({
    uuid: '00000000-0000-4000-8000-000000000008',
    inputTokens: 500,
    outputTokens: 10,
  }),
)
updateProgressFromMessage(
  compactedTracker,
  assistantMessage({
    uuid: '00000000-0000-4000-8000-000000000009',
    inputTokens: 100,
    outputTokens: 20,
  }),
)
assert.equal(getProgressUpdate(compactedTracker).tokenCount, 120)

const selectedAgent = {
  agentType: 'general-purpose',
  whenToUse: 'general',
  source: 'built-in' as const,
  baseDir: 'built-in' as const,
  getSystemPrompt: () => 'general',
}

let state = {
  ...getDefaultAppState(),
  tasks: {},
  toolPermissionContext: getEmptyToolPermissionContext(),
  mcp: { tools: [], clients: [] },
} as unknown as AppState

const setAppState = (fn: (prev: AppState) => AppState) => {
  state = fn(state)
}

registerAgentForeground({
  agentId: 'foreground-continuation-test',
  description: 'Foreground continuation test',
  prompt: 'continue in background',
  selectedAgent,
  setAppState,
  toolUseId: 'toolu_parent_continuation',
  spawnDepth: 1,
})

const continuationTracker = createProgressTracker()
const continuationMessage = assistantMessage({
  uuid: '00000000-0000-4000-8000-000000000007',
  inputTokens: 0,
  outputTokens: 0,
  toolUseId: 'toolu_continuation',
})
updateProgressFromMessage(continuationTracker, continuationMessage)
continuationMessage.message.usage.input_tokens = 200
continuationMessage.message.usage.output_tokens = 12
const continuationMessages: Message[] = [continuationMessage]
refreshLastAssistantProgress(continuationTracker, continuationMessages)
const finalProgress = publishAgentProgress(
  'foreground-continuation-test',
  continuationTracker,
  setAppState,
)
assert.equal(finalProgress.tokenCount, 212)
assert.equal(finalProgress.toolUseCount, 1)

resetCommandQueue()
enqueueAgentNotification({
  taskId: 'foreground-continuation-test',
  description: 'Foreground continuation test',
  status: 'completed',
  setAppState,
  finalMessage: 'done',
  usage: {
    totalTokens: finalProgress.tokenCount,
    toolUses: finalProgress.toolUseCount,
    durationMs: 123,
  },
  toolUseId: 'toolu_parent_continuation',
})
const [notification] = getCommandQueue()
assert.equal(notification?.mode, 'task-notification')
assert.match(String(notification?.value), /<status>completed<\/status>/)
assert.match(String(notification?.value), /<total_tokens>212<\/total_tokens>/)
assert.match(String(notification?.value), /<tool_uses>1<\/tool_uses>/)
assert.match(
  String(notification?.value),
  /<tool-use-id>toolu_parent_continuation<\/tool-use-id>/,
)
resetCommandQueue()

console.log('LocalAgentTask.progress.test.ts passed')
