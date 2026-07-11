import assert from 'node:assert/strict'

import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { AppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'
import {
  createProgressTracker,
  isLocalAgentTask,
  publishAgentProgress,
  registerAgentForeground,
  updateProgressFromMessage,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'

const selectedAgent = {
  agentType: 'general-purpose',
  whenToUse: 'general',
  source: 'built-in' as const,
  baseDir: 'built-in' as const,
  getSystemPrompt: () => 'general',
}

let state = {
  tasks: {},
  toolPermissionContext: getEmptyToolPermissionContext(),
  mcp: { tools: [], clients: [] },
} as unknown as AppState

const setAppState = (fn: (prev: AppState) => AppState) => {
  state = fn(state)
}

registerAgentForeground({
  agentId: 'foreground-progress-test',
  description: 'Foreground progress test',
  prompt: 'read once',
  selectedAgent,
  setAppState,
  toolUseId: 'toolu_parent',
  spawnDepth: 1,
})

const message = {
  type: 'assistant',
  uuid: crypto.randomUUID(),
  timestamp: '2026-07-11T00:00:00.000Z',
  message: {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_read',
        name: 'Read',
        input: { file_path: '/tmp/example' },
      },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: {
      input_tokens: 30,
      output_tokens: 4,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  },
} as Message

const tracker = createProgressTracker()
updateProgressFromMessage(tracker, message)
publishAgentProgress('foreground-progress-test', tracker, setAppState)

const task = state.tasks['foreground-progress-test']
assert.ok(isLocalAgentTask(task))
assert.equal(task.progress?.tokenCount, 34)
assert.equal(task.progress?.toolUseCount, 1)

console.log('foregroundProgressUpdate.test.ts passed')
