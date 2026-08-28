#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { Writable } from 'node:stream'
import React, { useState } from 'react'
import type {
  SDKAssistantMessage,
  SDKMessage,
} from '../entrypoints/agentSdkTypes.js'
import type { SpinnerMode } from '../components/Spinner/types.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import type { StreamingToolUse } from '../utils/messages.js'
import type { SSHSessionCallbacks } from '../ssh/SSHSessionManager.js'
import type { SSHSession } from '../ssh/createSSHSession.js'
import type { Message } from '../types/message.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}
process.env.NODE_ENV = 'test'

const { render } = await import('../ink.js')

mock.module('../utils/gracefulShutdown.js', () => ({
  gracefulShutdown: async () => {},
  isShuttingDown: () => false,
  registerSSHResumeHintContext: () => () => {},
}))

const { useSSHSession } = await import('./useSSHSession.js')

const remoteSessionId = '11111111-1111-4111-8111-111111111111'
const replayedAssistant: SDKAssistantMessage = {
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'history answer' }],
  },
  parent_tool_use_id: null,
  uuid: '22222222-2222-4222-8222-222222222222',
  session_id: remoteSessionId,
}

let callbacks: SSHSessionCallbacks | undefined
const sentMessages: Array<{ content: unknown; options: unknown }> = []
const fileSuggestionRequests: unknown[] = []
let disconnectCount = 0
let proxyStopCount = 0
const manager = {
  connect() {},
  disconnect() {
    disconnectCount++
  },
  async sendMessage(content: unknown, options: unknown) {
    sentMessages.push({ content, options })
    return true
  },
  respondToPermissionRequest() {},
  setPermissionMode: async () => ({ success: true as const }),
  runShellCommand: async () => ({
    stdout: '',
    stderr: '',
    code: 0,
    interrupted: false,
  }),
  sendInterrupt() {},
  async getPermissions() {
    return { overlay: {}, rules: [], additionalDirectories: [] }
  },
  async updatePermissions() {
    return { overlay: {}, rules: [], additionalDirectories: [] }
  },
  async getFileSuggestions(request: { mode?: string }) {
    fileSuggestionRequests.push(request)
    if (request.mode === 'path') {
      return {
        items: [
          { path: '/srv/project/src', kind: 'directory' as const },
          { path: '/srv/project/source.txt', kind: 'file' as const },
        ],
        incomplete: false,
      }
    }
    return {
      items: [{ path: 'src/index.ts', kind: 'file' as const }],
      incomplete: false,
    }
  },
}
const session = {
  target: 'test-host',
  remoteCwd: '/srv/project',
  proxy: {
    stop() {
      proxyStopCount++
    },
  },
  proc: { exitCode: null, signalCode: null },
  createManager(nextCallbacks: SSHSessionCallbacks) {
    callbacks = nextCallbacks
    return manager
  },
  getStderrTail: () => '',
} as unknown as SSHSession

let snapshot:
  | {
      messages: Message[]
      isReady: boolean
      remoteSessionId: string | null
      remoteFileSuggestionProvider: ReturnType<typeof useSSHSession>['remoteFileSuggestionProvider']
      managedSSHRemotePermissions: ReturnType<typeof useSSHSession>['managedSSHRemotePermissions']
      streamMode: SpinnerMode
      streamingToolUses: StreamingToolUse[]
      inProgressToolUseIDs: Set<string>
      permissionQueueSize: number
      responseLength: number
      streamingText: string | null
      remoteBackgroundTaskCount: number
      remoteTaskIds: string[]
      remoteTaskSummary: string | undefined
      remoteTaskLastToolName: string | undefined
      goalActive: boolean
      goalId: string | undefined
      sendMessage: (
        content: string,
        options: { uuid: string },
      ) => Promise<boolean>
      disconnect: () => void
    }
  | undefined

const setIsLoading = () => {}

function Harness(): null {
  const [messages, setMessages] = useState<Message[]>([])
  const [appState, setAppState] = useState(getDefaultAppState())
  const [permissionQueue, setToolUseConfirmQueue] = useState<
    import('../components/permissions/PermissionRequest.js').ToolUseConfirm[]
  >([])
  const [responseLength, setResponseLength] = useState(0)
  const [streamingText, setStreamingText] = useState<string | null>(null)
  const [streamMode, setStreamMode] = useState<SpinnerMode>('responding')
  const [streamingToolUses, setStreamingToolUses] = useState<
    StreamingToolUse[]
  >([])
  const [inProgressToolUseIDs, setInProgressToolUseIDs] = useState<Set<string>>(
    new Set(),
  )
  const ssh = useSSHSession({
    session,
    setMessages,
    setIsLoading,
    setAppState,
    setToolUseConfirmQueue,
    tools: [],
    setStreamMode,
    setStreamingToolUses,
    setInProgressToolUseIDs,
    setResponseLength,
    onStreamingText: setStreamingText,
  })
  snapshot = {
    messages,
    isReady: ssh.isReady,
    remoteSessionId: ssh.remoteSessionId,
    remoteFileSuggestionProvider: ssh.remoteFileSuggestionProvider,
    managedSSHRemotePermissions: ssh.managedSSHRemotePermissions,
    streamMode,
    streamingToolUses,
    inProgressToolUseIDs,
    permissionQueueSize: permissionQueue.length,
    responseLength,
    streamingText,
    remoteBackgroundTaskCount: appState.remoteBackgroundTaskCount,
    remoteTaskIds: Object.keys(appState.remoteTasks),
    remoteTaskSummary: appState.remoteTasks['task-1']?.summary,
    remoteTaskLastToolName: appState.remoteTasks['task-1']?.lastToolName,
    goalActive: appState.goalStatus.active,
    goalId: appState.goalStatus.active ? appState.goalStatus.id : undefined,
    sendMessage: ssh.sendMessage,
    disconnect: ssh.disconnect,
  }
  return null
}

class TestStdout extends Writable {
  columns = 120
  rows = 40
  isTTY = false

  _write(
    _chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    callback()
  }
}

const instance = await render(React.createElement(Harness), {
  stdout: new TestStdout() as unknown as NodeJS.WriteStream,
  patchConsole: false,
})
await new Promise(resolve => setImmediate(resolve))

assert.ok(snapshot)
assert.equal(snapshot.isReady, false)
assert.equal(snapshot.remoteFileSuggestionProvider, undefined)
assert.equal(
  await snapshot.sendMessage('too early', {
    uuid: '33333333-3333-4333-8333-333333333333',
  }),
  false,
)
assert.equal(sentMessages.length, 0)

callbacks?.onBootstrap?.({
  sessionId: remoteSessionId,
  history: [
    {
      type: 'system',
      subtype: 'goal_state_changed',
      goal: {
        type: 'goal_status',
        id: 'bootstrap-goal',
        condition: 'resume it',
        status: 'active',
        sentinel: true,
      },
      uuid: '32323232-3232-4232-8232-323232323232',
      session_id: remoteSessionId,
    },
    replayedAssistant,
  ],
})
await new Promise(resolve => setImmediate(resolve))

assert.ok(snapshot)
assert.equal(snapshot.isReady, true)
assert.equal(snapshot.remoteSessionId, remoteSessionId)
assert.equal(snapshot.goalActive, true)
assert.equal(snapshot.goalId, 'bootstrap-goal')
assert.ok(snapshot.remoteFileSuggestionProvider)
assert.ok(snapshot.managedSSHRemotePermissions)
assert.deepEqual(
  snapshot.messages.map(message => message.uuid),
  [replayedAssistant.uuid],
)

callbacks?.onMessage(replayedAssistant)
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(
  snapshot.messages.map(message => message.uuid),
  [replayedAssistant.uuid],
  'a live message already present in bootstrap history must be suppressed',
)

const emit = (message: SDKMessage) => callbacks?.onMessage(message)
emit({
  type: 'stream_event',
  event: {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  },
  parent_tool_use_id: null,
  uuid: '34343434-3434-4434-8434-343434343434',
  session_id: remoteSessionId,
})
for (const [text, uuid] of [
  ['streamed ', '45454545-4545-4545-8545-454545454545'],
  ['text\n', '46464646-4646-4646-8646-464646464646'],
] as const) {
  emit({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    },
    parent_tool_use_id: null,
    uuid,
    session_id: remoteSessionId,
  })
}
await new Promise(resolve => setImmediate(resolve))
assert.equal(snapshot.responseLength, 'streamed text\n'.length)
assert.equal(snapshot.streamingText, 'streamed text\n')

emit({
  type: 'stream_event',
  event: {
    type: 'content_block_start',
    index: 0,
    content_block: {
      type: 'tool_use',
      id: 'tool-1',
      name: 'Read',
      input: {},
    },
  },
  parent_tool_use_id: null,
  uuid: '55555555-5555-4555-8555-555555555555',
  session_id: remoteSessionId,
})
await new Promise(resolve => setImmediate(resolve))
assert.equal(snapshot.streamMode, 'tool-input')
assert.equal(snapshot.streamingToolUses.length, 1)
assert.equal(snapshot.streamingToolUses[0]?.contentBlock.id, 'tool-1')

emit({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }],
  },
  parent_tool_use_id: null,
  uuid: '66666666-6666-4666-8666-666666666666',
  session_id: remoteSessionId,
})
await new Promise(resolve => setImmediate(resolve))
assert.equal(snapshot.streamingToolUses.length, 0)
assert.equal(snapshot.streamingText, null)
assert.equal(snapshot.inProgressToolUseIDs.has('tool-1'), true)

emit({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }],
  },
  parent_tool_use_id: null,
  uuid: '77777777-7777-4777-8777-777777777777',
  session_id: remoteSessionId,
})
await new Promise(resolve => setImmediate(resolve))
assert.equal(snapshot.inProgressToolUseIDs.has('tool-1'), false)

callbacks?.onPermissionRequest?.(
  {
    subtype: 'can_use_tool',
    tool_name: 'Read',
    input: { file_path: '/tmp/test' },
    tool_use_id: 'permission-tool-1',
  },
  'permission-request-1',
)
await new Promise(resolve => setImmediate(resolve))
assert.equal(snapshot.permissionQueueSize, 1)

emit({
  type: 'result',
  subtype: 'success',
  duration_ms: 1,
  duration_api_ms: 1,
  is_error: false,
  num_turns: 1,
  result: 'done',
  stop_reason: 'end_turn',
  total_cost_usd: 0,
  usage: {},
  modelUsage: {},
  permission_denials: [],
  uuid: '78787878-7878-4878-8878-787878787878',
  session_id: remoteSessionId,
})
await new Promise(resolve => setImmediate(resolve))
assert.equal(
  snapshot.permissionQueueSize,
  0,
  'a terminal result must clear SSH-owned permission prompts',
)

for (const [taskId, uuid] of [
  ['task-1', '88888888-8888-4888-8888-888888888888'],
  ['task-2', '99999999-9999-4999-8999-999999999999'],
] as const) {
  emit({
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    description: taskId,
    uuid,
    session_id: remoteSessionId,
  })
}
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(snapshot.remoteTaskIds, ['task-1', 'task-2'])
assert.equal(snapshot.remoteBackgroundTaskCount, 2)

emit({
  type: 'system',
  subtype: 'task_started',
  task_id: 'task-1',
  description: 'task-1',
  uuid: '89898989-8989-4989-8989-898989898989',
  session_id: remoteSessionId,
})
emit({
  type: 'system',
  subtype: 'task_notification',
  task_id: 'unknown-task',
  status: 'completed',
  output_file: '/tmp/unknown-task',
  summary: 'done',
  uuid: '90909090-9090-4090-8090-909090909090',
  session_id: remoteSessionId,
})
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(snapshot.remoteTaskIds, ['task-1', 'task-2'])
assert.equal(snapshot.remoteBackgroundTaskCount, 2)

emit({
  type: 'system',
  subtype: 'task_progress',
  task_id: 'task-1',
  description: 'checking',
  usage: { total_tokens: 12, tool_uses: 1, duration_ms: 50 },
  last_tool_name: 'Read',
  summary: 'read one file',
  uuid: 'abababab-abab-4bab-8bab-abababababab',
  session_id: remoteSessionId,
})
await new Promise(resolve => setImmediate(resolve))
assert.equal(snapshot.remoteTaskSummary, 'read one file')
assert.equal(snapshot.remoteTaskLastToolName, 'Read')

emit({
  type: 'system',
  subtype: 'task_notification',
  task_id: 'task-2',
  status: 'stopped',
  output_file: '/tmp/task-2',
  summary: 'cancelled',
  uuid: 'a9a9a9a9-a9a9-49a9-89a9-a9a9a9a9a9a9',
  session_id: remoteSessionId,
})
await new Promise(resolve => setImmediate(resolve))
assert.equal(snapshot.remoteTaskIds.includes('task-2'), false)
assert.equal(snapshot.remoteBackgroundTaskCount, 1)

emit({
  type: 'system',
  subtype: 'task_notification',
  task_id: 'task-1',
  status: 'completed',
  output_file: '/tmp/task-1',
  summary: 'done',
  uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  session_id: remoteSessionId,
})
await new Promise(resolve => setImmediate(resolve))
assert.equal(snapshot.remoteBackgroundTaskCount, 0)
assert.equal(snapshot.remoteTaskIds.includes('task-1'), false)

emit({
  type: 'system',
  subtype: 'goal_state_changed',
  goal: {
    type: 'goal_status',
    id: 'goal-1',
    condition: 'ship it',
    status: 'active',
    sentinel: true,
  },
  uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  session_id: remoteSessionId,
})
await new Promise(resolve => setImmediate(resolve))
assert.equal(snapshot.goalActive, true)
assert.equal(snapshot.goalId, 'goal-1')

emit({
  type: 'system',
  subtype: 'goal_state_changed',
  goal: {
    type: 'goal_status',
    id: 'stale-goal',
    condition: 'old',
    status: 'met',
    sentinel: true,
  },
  uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  session_id: remoteSessionId,
})
await new Promise(resolve => setImmediate(resolve))
assert.equal(snapshot.goalActive, true)
assert.equal(snapshot.goalId, 'goal-1')

emit({
  type: 'system',
  subtype: 'goal_state_changed',
  goal: {
    type: 'goal_status',
    id: 'goal-1',
    condition: 'ship it',
    status: 'met',
    sentinel: true,
  },
  uuid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  session_id: remoteSessionId,
})
await new Promise(resolve => setImmediate(resolve))
assert.equal(snapshot.goalActive, false)

const localUuid = '44444444-4444-4444-8444-444444444444'
assert.equal(await snapshot.sendMessage('next', { uuid: localUuid }), true)
assert.deepEqual(sentMessages, [
  { content: 'next', options: { uuid: localUuid } },
])
const suggestions = await snapshot.remoteFileSuggestionProvider(
  { query: 'src', mode: 'fuzzy', limit: 20 },
  new AbortController().signal,
)
assert.deepEqual(suggestions.items, [{ path: 'src/index.ts', kind: 'file' }])
assert.deepEqual(
  await snapshot.managedSSHRemotePermissions.getDirectorySuggestions(
    '/srv/project/s',
    new AbortController().signal,
  ),
  [{ path: '/srv/project/src', kind: 'directory' }],
)
assert.deepEqual(fileSuggestionRequests, [
  { query: 'src', mode: 'fuzzy', limit: 20 },
  { query: '/srv/project/s', mode: 'path', limit: 10 },
])

callbacks?.onPermissionRequest?.(
  {
    subtype: 'can_use_tool',
    tool_name: 'Read',
    input: { file_path: '/tmp/disconnect' },
    tool_use_id: 'disconnect-permission-tool',
  },
  'disconnect-permission-request',
)
await new Promise(resolve => setImmediate(resolve))
assert.equal(snapshot.permissionQueueSize, 1)
callbacks?.onDisconnected?.()
await new Promise(resolve => setImmediate(resolve))
assert.equal(snapshot.permissionQueueSize, 0)
assert.equal(snapshot.remoteSessionId, null)
assert.equal(snapshot.isReady, false)
assert.equal(snapshot.remoteBackgroundTaskCount, 0)
assert.deepEqual(snapshot.remoteTaskIds, [])
assert.equal(snapshot.inProgressToolUseIDs.size, 0)

snapshot.disconnect()
await new Promise(resolve => setImmediate(resolve))
assert.equal(disconnectCount, 1)
assert.equal(proxyStopCount, 1)
assert.equal(snapshot.permissionQueueSize, 0)
assert.equal(snapshot.isReady, false)
assert.equal(snapshot.remoteSessionId, null)
assert.equal(snapshot.remoteFileSuggestionProvider, undefined)
assert.equal(snapshot.remoteBackgroundTaskCount, 0)
assert.deepEqual(snapshot.remoteTaskIds, [])
assert.equal(snapshot.inProgressToolUseIDs.size, 0)

instance.unmount()
instance.cleanup()

console.log('useSSHSession.test.tsx passed')
