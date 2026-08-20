import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, it, jest } from 'bun:test'
import {
  CONTROL_REQUEST_TIMEOUT_MS,
  SSHSessionManager,
} from './SSHSessionManager.js'

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
      updatedPermissions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'pwd' }],
          behavior: 'allow',
          destination: 'session',
        },
      ],
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
          updatedPermissions: [
            {
              type: 'addRules',
              rules: [{ toolName: 'Bash', ruleContent: 'pwd' }],
              behavior: 'allow',
              destination: 'session',
            },
          ],
        },
      },
    })
  })

  it('consumes replayed permission responses', async () => {
    const proc = createFakeProcess()
    const errors: Error[] = []
    const manager = new SSHSessionManager(proc as never, {
      onMessage() {},
      onPermissionRequest() {},
      onError: error => errors.push(error),
    })

    manager.connect()
    proc.stdout.write(
      '{"type":"control_request","request_id":"req-1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"pwd"},"tool_use_id":"tool-1"}}\n',
    )
    await nextTick()

    manager.respondToPermissionRequest('req-1', {
      behavior: 'allow',
      updatedInput: { command: 'pwd' },
    })
    proc.stdout.write(
      '{"type":"control_response","response":{"subtype":"success","request_id":"req-1","response":{"behavior":"allow","updatedInput":{"command":"pwd"}}}}\n',
    )
    await nextTick()

    assert.deepEqual(errors, [])
    assert.equal(
      (
        manager as unknown as {
          expectedPermissionResponseEchoes: Map<string, unknown>
        }
      ).expectedPermissionResponseEchoes.size,
      0,
    )
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

  it('times out an unanswered permission mode change', async () => {
    jest.useFakeTimers()
    try {
      const proc = createFakeProcess()
      const manager = new SSHSessionManager(proc as never, {
        onMessage() {},
        onPermissionRequest() {},
      })

      manager.connect()
      const result = manager.setPermissionMode('plan')
      jest.advanceTimersByTime(CONTROL_REQUEST_TIMEOUT_MS)

      assert.deepEqual(await result, {
        success: false,
        error: 'SSH permission mode change timed out',
      })
    } finally {
      jest.useRealTimers()
    }
  })

  it('rejects remote shell commands without a session capability', async () => {
    const proc = createFakeProcess()
    const manager = new SSHSessionManager(proc as never, {
      onMessage() {},
      onPermissionRequest() {},
    })

    manager.connect()

    await assert.rejects(
      manager.runShellCommand('pwd', new AbortController().signal),
      /unavailable in this SSH session/,
    )
  })

  it('runs remote shell commands and correlates their responses', async () => {
    const proc = createFakeProcess()
    let written = ''
    proc.stdin.on('data', chunk => {
      written += String(chunk)
    })
    const manager = new SSHSessionManager(
      proc as never,
      {
        onMessage() {},
        onPermissionRequest() {},
      },
      'test-ssh-token',
    )

    manager.connect()
    const controller = new AbortController()
    const result = manager.runShellCommand('pwd', controller.signal)
    await nextTick()

    const message = JSON.parse(written.trim())
    assert.equal(message.type, 'control_request')
    assert.equal(message.request.subtype, 'run_shell_command')
    assert.equal(message.request.command, 'pwd')
    assert.equal(message.request.ssh_remote_token, 'test-ssh-token')

    proc.stdout.write(
      `${JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: message.request_id,
          response: {
            stdout: '/work\n',
            stderr: '',
            code: 0,
            interrupted: false,
          },
        },
      })}\n`,
    )

    assert.deepEqual(await result, {
      stdout: '/work\n',
      stderr: '',
      code: 0,
      interrupted: false,
    })
  })

  it('interrupts an active remote shell command through stream-json', async () => {
    const proc = createFakeProcess()
    let written = ''
    proc.stdin.on('data', chunk => {
      written += String(chunk)
    })
    const manager = new SSHSessionManager(
      proc as never,
      {
        onMessage() {},
        onPermissionRequest() {},
      },
      'test-ssh-token',
    )

    manager.connect()
    const controller = new AbortController()
    const result = manager.runShellCommand('sleep 30', controller.signal)
    controller.abort('user-cancel')
    await nextTick()

    const messages = written.trim().split('\n').map(line => JSON.parse(line))
    assert.equal(messages[0].request.subtype, 'run_shell_command')
    assert.equal(messages[0].request.ssh_remote_token, 'test-ssh-token')
    assert.equal(messages[1].request.subtype, 'interrupt')

    proc.stdout.write(
      `${JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: messages[0].request_id,
          response: {
            stdout: '',
            stderr: '',
            code: 137,
            interrupted: true,
          },
        },
      })}\n`,
    )
    assert.equal((await result).interrupted, true)
  })

  it('times out a cancelled shell command without a final shell response', async () => {
    jest.useFakeTimers()
    try {
      const proc = createFakeProcess()
      const manager = new SSHSessionManager(
        proc as never,
        {
          onMessage() {},
          onPermissionRequest() {},
        },
        'test-ssh-token',
      )

      manager.connect()
      const controller = new AbortController()
      const result = manager.runShellCommand('sleep 30', controller.signal)
      controller.abort('user-cancel')
      jest.advanceTimersByTime(CONTROL_REQUEST_TIMEOUT_MS)

      await assert.rejects(result, /SSH shell command cancellation timed out/)
    } finally {
      jest.useRealTimers()
    }
  })

  it('rejects an active remote shell command on disconnect', async () => {
    const proc = createFakeProcess()
    const manager = new SSHSessionManager(
      proc as never,
      {
        onMessage() {},
        onPermissionRequest() {},
      },
      'test-ssh-token',
    )

    manager.connect()
    const result = manager.runShellCommand('sleep 30', new AbortController().signal)
    proc.exitCode = 1
    proc.emit('close', 1, null)

    await assert.rejects(result, /SSH session disconnected/)
  })

  it('rejects invalid remote shell command responses', async () => {
    const proc = createFakeProcess()
    let written = ''
    proc.stdin.on('data', chunk => {
      written += String(chunk)
    })
    const manager = new SSHSessionManager(
      proc as never,
      {
        onMessage() {},
        onPermissionRequest() {},
      },
      'test-ssh-token',
    )

    manager.connect()
    const result = manager.runShellCommand('pwd', new AbortController().signal)
    await nextTick()
    const message = JSON.parse(written.trim())
    proc.stdout.write(
      `${JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: message.request_id,
          response: { stdout: 1 },
        },
      })}\n`,
    )

    await assert.rejects(result, /Invalid SSH shell command response/)
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

  it('bootstraps remote history before accepting UUID-preserving user input', async () => {
    const proc = createFakeProcess()
    const written: Array<Record<string, unknown>> = []
    proc.stdin.on('data', chunk => {
      for (const line of String(chunk).trim().split('\n')) {
        if (line) written.push(JSON.parse(line))
      }
    })
    const bootstraps: Array<{
      sessionId: string
      history: Array<Record<string, unknown>>
    }> = []
    let connected = 0
    const manager = new SSHSessionManager(
      proc as never,
      {
        onMessage() {},
        onPermissionRequest() {},
        onBootstrap: bootstrap =>
          bootstraps.push(
            bootstrap as {
              sessionId: string
              history: Array<Record<string, unknown>>
            },
          ),
        onConnected: () => connected++,
      },
      'test-ssh-token',
    )

    manager.connect()
    await nextTick()

    assert.equal(await manager.sendMessage('too early', { uuid: 'early' }), false)
    assert.equal(written[0]?.type, 'control_request')
    assert.equal(
      (written[0]?.request as Record<string, unknown>)?.subtype,
      'replay_history',
    )
    const requestId = written[0]?.request_id

    const historicalUser = {
      type: 'user',
      uuid: 'history-user',
      session_id: 'remote-session',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'before reconnect' },
    }
    proc.stdout.write(
      `${JSON.stringify({
        type: 'ssh_history_chunk',
        request_id: requestId,
        sequence: 0,
        messages: [historicalUser],
      })}\n`,
    )
    proc.stdout.write(
      `${JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: {
            session_id: 'remote-session',
            count: 1,
            last_uuid: 'history-user',
          },
        },
      })}\n`,
    )
    await nextTick()

    assert.equal(connected, 1)
    assert.deepEqual(bootstraps, [
      { sessionId: 'remote-session', history: [historicalUser] },
    ])
    assert.equal(
      await manager.sendMessage('after reconnect', { uuid: 'local-user-id' }),
      true,
    )
    await nextTick()
    assert.deepEqual(written[1], {
      type: 'user',
      uuid: 'local-user-id',
      message: { role: 'user', content: 'after reconnect' },
      parent_tool_use_id: null,
      session_id: 'remote-session',
    })
  })

  it('queries and independently cancels remote file suggestions', async () => {
    const proc = createFakeProcess()
    const written: Array<Record<string, unknown>> = []
    proc.stdin.on('data', chunk => {
      for (const line of String(chunk).trim().split('\n')) {
        if (line) written.push(JSON.parse(line))
      }
    })
    const manager = new SSHSessionManager(
      proc as never,
      { onMessage() {}, onPermissionRequest() {} },
      'test-ssh-token',
    )
    manager.connect()

    const controller = new AbortController()
    const suggestions = manager.getFileSuggestions(
      { query: 'src/pri', mode: 'path', limit: 10 },
      controller.signal,
    )
    await nextTick()
    assert.deepEqual(written[0]?.request, {
      subtype: 'ssh_file_suggestions',
      version: 1,
      query: 'src/pri',
      mode: 'path',
      limit: 10,
      ssh_remote_token: 'test-ssh-token',
    })
    proc.stdout.write(
      `${JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: written[0]?.request_id,
          response: {
            items: [{ path: 'src/print.ts', kind: 'file', score: 1 }],
            incomplete: false,
          },
        },
      })}\n`,
    )
    assert.deepEqual(await suggestions, {
      items: [{ path: 'src/print.ts', kind: 'file', score: 1 }],
      incomplete: false,
    })

    const cancelledController = new AbortController()
    const cancelled = manager.getFileSuggestions(
      { query: 'src/a', mode: 'fuzzy', limit: 20 },
      cancelledController.signal,
    )
    cancelledController.abort()
    await assert.rejects(cancelled, error => {
      assert.equal((error as Error).name, 'AbortError')
      return true
    })
    await nextTick()
    assert.deepEqual(written[2], {
      type: 'control_cancel_request',
      request_id: written[1]?.request_id,
    })
  })

  it('consumes interrupt acknowledgements without reporting them as unmatched', async () => {
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
    manager.sendInterrupt()
    await nextTick()

    const request = JSON.parse(written.trim())
    proc.stdout.write(
      `${JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: request.request_id,
          response: {},
        },
      })}\n`,
    )
    await nextTick()

    assert.deepEqual(errors, [])
  })

  it('surfaces interrupt acknowledgement errors', async () => {
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
    manager.sendInterrupt()
    await nextTick()

    const request = JSON.parse(written.trim())
    proc.stdout.write(
      `${JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: request.request_id,
          error: 'interrupt failed',
        },
      })}\n`,
    )
    await nextTick()

    assert.equal(errors[0]?.message, 'interrupt failed')
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

  it('reports malformed control responses without throwing', async () => {
    const proc = createFakeProcess()
    const errors: string[] = []
    const manager = new SSHSessionManager(proc as never, {
      onMessage() {},
      onPermissionRequest() {},
      onError: error => errors.push(error.message),
    })

    manager.connect()
    proc.stdout.write('{"type":"control_response"}\n')
    proc.stdout.write(
      '{"type":"control_response","response":{"subtype":"error","request_id":"req-1"}}\n',
    )
    await nextTick()

    assert.deepEqual(errors, [
      'Invalid control response from SSH child',
      'Invalid control response from SSH child',
    ])
    assert.equal(manager.isConnected(), true)
  })

  it('keeps pending shell requests after unrelated malformed responses', async () => {
    const proc = createFakeProcess()
    let written = ''
    proc.stdin.on('data', chunk => {
      written += String(chunk)
    })
    const manager = new SSHSessionManager(
      proc as never,
      {
        onMessage() {},
        onPermissionRequest() {},
      },
      'test-ssh-token',
    )

    manager.connect()
    const result = manager.runShellCommand('pwd', new AbortController().signal)
    await nextTick()
    const request = JSON.parse(written.trim())

    proc.stdout.write('{"type":"control_response","response":null}\n')
    proc.stdout.write(
      `${JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: request.request_id,
          response: {
            stdout: '/work\n',
            stderr: '',
            code: 0,
            interrupted: false,
          },
        },
      })}\n`,
    )

    assert.equal((await result).stdout, '/work\n')
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
