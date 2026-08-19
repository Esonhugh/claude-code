import { afterEach, describe, expect, it } from 'bun:test'
import type { SDKControlPermissionRequest } from '../entrypoints/sdk/controlTypes.js'
import { DirectConnectSessionManager } from './directConnectManager.js'

class FakeWebSocket {
  static readonly OPEN = 1
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.OPEN
  sent: string[] = []
  private listeners = new Map<string, ((event: { data?: string }) => void)[]>()

  constructor() {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(
    type: string,
    listener: (event: { data?: string }) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  send(message: string): void {
    this.sent.push(message)
  }

  close(): void {}

  emit(type: string, data?: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data })
  }
}

const originalWebSocket = globalThis.WebSocket

afterEach(() => {
  globalThis.WebSocket = originalWebSocket
  FakeWebSocket.instances = []
})

function createManager(callbacks?: {
  onPermissionRequest?: (
    request: SDKControlPermissionRequest,
    requestId: string,
  ) => void
  onPermissionCancelled?: (
    requestId: string,
    toolUseId: string | undefined,
  ) => void
}) {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  const errors: Error[] = []
  const manager = new DirectConnectSessionManager(
    {
      serverUrl: 'https://example.test',
      sessionId: 'session-1',
      wsUrl: 'wss://example.test/session-1',
    },
    {
      onMessage() {},
      onPermissionRequest: callbacks?.onPermissionRequest ?? (() => {}),
      onPermissionCancelled: callbacks?.onPermissionCancelled,
      onError: error => errors.push(error),
    },
  )
  manager.connect()
  return { manager, socket: FakeWebSocket.instances[0]!, errors }
}

describe('DirectConnectSessionManager control protocol', () => {
  it('reports malformed JSON without throwing', () => {
    const { socket, errors } = createManager()

    expect(() => socket.emit('message', '{')).not.toThrow()

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toBe('Invalid direct-connect message')
    expect(socket.sent).toEqual([])
  })

  it('rejects malformed control requests without throwing', () => {
    const { socket, errors } = createManager()

    expect(() => {
      socket.emit(
        'message',
        JSON.stringify({ type: 'control_request', request_id: 'req-1' }),
      )
    }).not.toThrow()

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toBe('Invalid direct-connect message')
    expect(socket.sent.map(message => JSON.parse(message))).toEqual([
      {
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: 'req-1',
          error: 'Invalid direct-connect control request',
        },
      },
    ])
  })

  it('rejects unsupported control request subtypes', () => {
    const { socket, errors } = createManager()

    socket.emit(
      'message',
      JSON.stringify({
        type: 'control_request',
        request_id: 'req-1',
        request: { subtype: 'interrupt' },
      }),
    )

    expect(errors).toEqual([])
    expect(socket.sent.map(message => JSON.parse(message))).toEqual([
      {
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: 'req-1',
          error: 'Unsupported control request subtype: interrupt',
        },
      },
    ])
  })

  it('propagates server cancellation for pending permissions', () => {
    const requests: string[] = []
    const cancellations: [string, string | undefined][] = []
    const { socket } = createManager({
      onPermissionRequest: (_request, requestId) => requests.push(requestId),
      onPermissionCancelled: (requestId, toolUseId) =>
        cancellations.push([requestId, toolUseId]),
    })

    socket.emit(
      'message',
      JSON.stringify({
        type: 'control_request',
        request_id: 'req-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          input: { command: 'pwd' },
          tool_use_id: 'tool-1',
        },
      }),
    )
    socket.emit(
      'message',
      JSON.stringify({ type: 'control_cancel_request', request_id: 'req-1' }),
    )

    expect(requests).toEqual(['req-1'])
    expect(cancellations).toEqual([['req-1', 'tool-1']])
  })

  it('ignores permission responses after server cancellation', () => {
    const { manager, socket } = createManager()
    socket.emit(
      'message',
      JSON.stringify({
        type: 'control_request',
        request_id: 'req-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          input: { command: 'pwd' },
          tool_use_id: 'tool-1',
        },
      }),
    )
    socket.emit(
      'message',
      JSON.stringify({ type: 'control_cancel_request', request_id: 'req-1' }),
    )

    manager.respondToPermissionRequest('req-1', {
      behavior: 'allow',
      updatedInput: { command: 'pwd' },
    })

    expect(socket.sent).toEqual([])
  })

  it.each(['error', 'close']) (
    'clears pending permissions when the socket emits %s',
    event => {
      const { manager, socket, errors } = createManager()
      socket.emit(
        'message',
        JSON.stringify({
          type: 'control_request',
          request_id: 'req-1',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Bash',
            input: { command: 'pwd' },
            tool_use_id: 'tool-1',
          },
        }),
      )
      socket.emit(event)

      manager.respondToPermissionRequest('req-1', {
        behavior: 'allow',
        updatedInput: { command: 'pwd' },
      })

      expect(socket.sent).toEqual([])
      expect(errors.map(error => error.message)).toEqual(
        event === 'error' ? ['WebSocket connection error'] : [],
      )
    },
  )
})
