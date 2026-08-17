import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, it } from 'bun:test'
import { SSHSessionManager } from './SSHSessionManager.js'

type FakeProcess = EventEmitter & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  kill: (signal?: NodeJS.Signals) => boolean
}

function createFakeProcess(): FakeProcess {
  const proc = new EventEmitter() as FakeProcess
  proc.stdin = new PassThrough()
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  proc.exitCode = null
  proc.signalCode = null
  proc.kill = signal => {
    proc.signalCode = signal ?? 'SIGTERM'
    return true
  }
  return proc
}

function nextTick(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

describe('SSHSessionManager', () => {
  it('reports connected only after the first init message', async () => {
    const proc = createFakeProcess()
    const messages: Array<Record<string, unknown>> = []
    let connected = 0
    const manager = new SSHSessionManager(proc as never, {
      onMessage: message => messages.push(message as unknown as Record<string, unknown>),
      onPermissionRequest() {},
      onConnected: () => connected++,
    })

    manager.connect()
    assert.equal(connected, 0)

    proc.stdout.write('{"type":"system","subtype":"init","model":"test"}\n')
    proc.stdout.write('{"type":"system","subtype":"init","model":"test"}\n')
    proc.stdout.write('{"type":"result","subtype":"success","result":"ok"}\n')
    await nextTick()

    assert.equal(connected, 1)
    assert.deepEqual(messages.map(message => message.type), [
      'system',
      'system',
      'result',
    ])
  })

  it('routes permission requests and writes responses', async () => {
    const proc = createFakeProcess()
    let requestId = ''
    let toolName = ''
    let written = ''
    proc.stdin.on('data', chunk => {
      written += String(chunk)
    })
    const manager = new SSHSessionManager(proc as never, {
      onMessage() {},
      onPermissionRequest(request, id) {
        requestId = id
        toolName = request.tool_name
      },
    })

    manager.connect()
    proc.stdout.write(
      '{"type":"control_request","request_id":"req-1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"pwd"},"tool_use_id":"tool-1"}}\n',
    )
    await nextTick()

    assert.equal(requestId, 'req-1')
    assert.equal(toolName, 'Bash')

    manager.respondToPermissionRequest('req-1', {
      behavior: 'allow',
      updatedInput: { command: 'pwd' },
    })
    await nextTick()

    assert.deepEqual(JSON.parse(written.trim()), {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-1',
        response: {
          behavior: 'allow',
          updatedInput: { command: 'pwd' },
        },
      },
    })
  })

  it('removes cancelled permission requests', async () => {
    const proc = createFakeProcess()
    const cancelled: Array<[string, string | undefined]> = []
    const errors: string[] = []
    const manager = new SSHSessionManager(proc as never, {
      onMessage() {},
      onPermissionRequest() {},
      onPermissionCancelled: (requestId, toolUseId) => {
        cancelled.push([requestId, toolUseId])
      },
      onError: error => errors.push(error.message),
    })

    manager.connect()
    proc.stdout.write(
      '{"type":"control_request","request_id":"req-1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"pwd"},"tool_use_id":"tool-1"}}\n',
    )
    proc.stdout.write(
      '{"type":"control_cancel_request","request_id":"req-1"}\n',
    )
    await nextTick()

    assert.deepEqual(cancelled, [['req-1', 'tool-1']])
    manager.respondToPermissionRequest('req-1', {
      behavior: 'deny',
      message: 'too late',
    })
    assert.match(errors[0] ?? '', /No pending SSH permission request/)
  })

  it('writes permission mode changes as stream-json control input', async () => {
    const proc = createFakeProcess()
    let written = ''
    proc.stdin.on('data', chunk => {
      written += String(chunk)
    })
    const manager = new SSHSessionManager(proc as never, {
      onMessage() {},
      onPermissionRequest() {},
    })

    manager.connect()
    const result = manager.setPermissionMode('bypassPermissions')
    await nextTick()

    const message = JSON.parse(written.trim())
    assert.equal(message.type, 'control_request')
    assert.equal(message.request.subtype, 'set_permission_mode')
    assert.equal(message.request.mode, 'bypassPermissions')
    assert.equal(typeof message.request_id, 'string')

    proc.stdout.write(
      `${JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: message.request_id,
          response: { mode: 'bypassPermissions' },
        },
      })}\n`,
    )
    assert.deepEqual(await result, { success: true })
  })

  it('reports rejected permission mode changes without changing local state', async () => {
    const proc = createFakeProcess()
    let written = ''
    proc.stdin.on('data', chunk => {
      written += String(chunk)
    })
    const manager = new SSHSessionManager(proc as never, {
      onMessage() {},
      onPermissionRequest() {},
    })

    manager.connect()
    const result = manager.setPermissionMode('bypassPermissions')
    await nextTick()
    const message = JSON.parse(written.trim())

    proc.stdout.write(
      `${JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: message.request_id,
          error: 'session was not launched with permission opt-in',
        },
      })}\n`,
    )
    assert.deepEqual(await result, {
      success: false,
      error: 'session was not launched with permission opt-in',
    })
  })

  it('writes user messages and interrupts as stream-json control input', async () => {
    const proc = createFakeProcess()
    let written = ''
    proc.stdin.on('data', chunk => {
      written += String(chunk)
    })
    const manager = new SSHSessionManager(proc as never, {
      onMessage() {},
      onPermissionRequest() {},
    })

    manager.connect()
    assert.equal(await manager.sendMessage('hello'), true)
    manager.sendInterrupt()
    await nextTick()

    const lines = written.trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(lines[0], {
      type: 'user',
      message: { role: 'user', content: 'hello' },
      parent_tool_use_id: null,
      session_id: '',
    })
    assert.equal(lines[1].type, 'control_request')
    assert.equal(lines[1].request.subtype, 'interrupt')
    assert.equal(typeof lines[1].request_id, 'string')
  })

  it('rejects malformed control requests without throwing', async () => {
    const proc = createFakeProcess()
    const errors: Error[] = []
    let written = ''
    proc.stdin.on('data', chunk => {
      written += String(chunk)
    })
    const manager = new SSHSessionManager(proc as never, {
      onMessage() {},
      onPermissionRequest() {},
      onError: error => errors.push(error),
    })

    manager.connect()
    proc.stdout.write(
      '{"type":"control_request","request_id":"req-1"}\n',
    )
    await nextTick()

    assert.equal(errors.length, 0)
    assert.deepEqual(JSON.parse(written.trim()), {
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: 'req-1',
        error: 'Unsupported or invalid control request',
      },
    })
  })

  it('reports a process that exited before connect', () => {
    const proc = createFakeProcess()
    proc.exitCode = 1
    let disconnected = 0
    const manager = new SSHSessionManager(proc as never, {
      onMessage() {},
      onPermissionRequest() {},
      onDisconnected: () => disconnected++,
    })

    manager.connect()

    assert.equal(disconnected, 1)
    assert.equal(manager.isConnected(), false)
  })

  it('surfaces malformed output and process exit', async () => {
    const proc = createFakeProcess()
    const errors: string[] = []
    let disconnected = 0
    const manager = new SSHSessionManager(proc as never, {
      onMessage() {},
      onPermissionRequest() {},
      onDisconnected: () => disconnected++,
      onError: error => errors.push(error.message),
    })

    manager.connect()
    proc.stdout.write('not-json\n')
    proc.exitCode = 1
    proc.emit('close', 1, null)
    await nextTick()

    assert.match(errors[0] ?? '', /Invalid stream-json output/)
    assert.equal(disconnected, 1)
  })
})
