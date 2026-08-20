#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import React, { useState } from 'react'
import type { SDKAssistantMessage } from '../entrypoints/agentSdkTypes.js'
import type { SSHSessionCallbacks } from '../ssh/SSHSessionManager.js'
import type { SSHSession } from '../ssh/createSSHSession.js'
import type { Message } from '../types/message.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}
process.env.NODE_ENV = 'test'

const { render } = await import('../ink.js')
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
const manager = {
  connect() {},
  disconnect() {},
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
  async getFileSuggestions(request: unknown) {
    fileSuggestionRequests.push(request)
    return {
      items: [{ path: 'src/index.ts', kind: 'file' as const }],
      incomplete: false,
    }
  },
}
const session = {
  target: 'test-host',
  remoteCwd: '/srv/project',
  proxy: { stop() {} },
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
      sendMessage: (
        content: string,
        options: { uuid: string },
      ) => Promise<boolean>
      disconnect: () => void
    }
  | undefined

const setIsLoading = () => {}
const setToolUseConfirmQueue = () => {}

function Harness(): null {
  const [messages, setMessages] = useState<Message[]>([])
  const ssh = useSSHSession({
    session,
    setMessages,
    setIsLoading,
    setToolUseConfirmQueue,
    tools: [],
  })
  snapshot = {
    messages,
    isReady: ssh.isReady,
    remoteSessionId: ssh.remoteSessionId,
    remoteFileSuggestionProvider: ssh.remoteFileSuggestionProvider,
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
  history: [replayedAssistant],
})
await new Promise(resolve => setImmediate(resolve))

assert.ok(snapshot)
assert.equal(snapshot.isReady, true)
assert.equal(snapshot.remoteSessionId, remoteSessionId)
assert.ok(snapshot.remoteFileSuggestionProvider)
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
assert.deepEqual(fileSuggestionRequests, [
  { query: 'src', mode: 'fuzzy', limit: 20 },
])

snapshot.disconnect()
await new Promise(resolve => setImmediate(resolve))
assert.equal(snapshot.isReady, false)
assert.equal(snapshot.remoteFileSuggestionProvider, undefined)

instance.unmount()
instance.cleanup()

console.log('useSSHSession.test.tsx passed')
