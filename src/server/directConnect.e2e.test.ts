import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import type { Server, ServerWebSocket } from 'bun'
import { runConnectHeadless } from './connectHeadless.js'
import {
  createDirectConnectSession,
  DirectConnectError,
} from './createDirectConnectSession.js'
import { DirectConnectSessionManager } from './directConnectManager.js'

const TOKEN = 'test-token'

type Fake = {
  server: Server<undefined>
  posts: { auth: string | null; body: unknown }[]
  received: Record<string, unknown>[]
  wsAuth: (string | null)[]
}

// Scripted stand-in for `claude server`: POST /sessions, then a WS that
// plays one turn — assistant text, a can_use_tool request, and a result once
// the permission answer arrives.
function startFakeServer(): Fake {
  const fake: Omit<Fake, 'server'> = { posts: [], received: [], wsAuth: [] }
  const send = (ws: ServerWebSocket<unknown>, msg: unknown) =>
    ws.send(JSON.stringify(msg) + '\n')
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url)
      const auth = req.headers.get('authorization')
      if (req.method === 'POST' && url.pathname === '/sessions') {
        fake.posts.push({ auth, body: await req.json() })
        if (auth !== `Bearer ${TOKEN}`) {
          return new Response('bad token', { status: 401 })
        }
        return Response.json({
          session_id: 'sess-1',
          ws_url: `ws://${url.host}/sessions/sess-1/ws`,
          work_dir: '/remote/dir',
        })
      }
      if (url.pathname === '/sessions/sess-1/ws') {
        fake.wsAuth.push(auth)
        if (srv.upgrade(req)) return undefined
      }
      return new Response('not found', { status: 404 })
    },
    websocket: {
      message(ws, data) {
        for (const line of String(data).split('\n').filter(Boolean)) {
          const msg = JSON.parse(line) as Record<string, unknown>
          fake.received.push(msg)
          if (msg.type === 'user') {
            send(ws, {
              type: 'assistant',
              message: {
                id: 'm1',
                type: 'message',
                role: 'assistant',
                model: 'fake',
                content: [{ type: 'text', text: 'working' }],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 1 },
              },
              parent_tool_use_id: null,
              uuid: '00000000-0000-4000-8000-000000000001',
              session_id: 'sess-1',
            })
            send(ws, {
              type: 'control_request',
              request_id: 'perm-1',
              request: {
                subtype: 'can_use_tool',
                tool_name: 'Bash',
                input: { command: 'echo hi' },
                tool_use_id: 'toolu_1',
              },
            })
          }
          if (msg.type === 'control_response') {
            const response = msg.response as {
              response: { behavior: string }
            }
            const allowed = response.response.behavior === 'allow'
            send(ws, {
              type: 'result',
              subtype: 'success',
              is_error: false,
              result: allowed ? 'done: allowed' : 'done: denied',
              stop_reason: 'end_turn',
              duration_ms: 1,
              duration_api_ms: 1,
              num_turns: 1,
              total_cost_usd: 0,
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
              modelUsage: {},
              permission_denials: [],
              uuid: '00000000-0000-4000-8000-000000000002',
              session_id: 'sess-1',
            })
          }
        }
      },
    },
  })
  return { server, ...fake }
}

let fake: Fake | undefined
afterEach(() => {
  fake?.server.stop(true)
  fake = undefined
})

function captureStdout() {
  const chunks: string[] = []
  const spy = spyOn(process.stdout, 'write').mockImplementation(((
    chunk: string,
  ) => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stdout.write)
  const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(
    (() => true) as typeof process.stderr.write,
  )
  return {
    chunks,
    restore: () => {
      spy.mockRestore()
      stderrSpy.mockRestore()
    },
  }
}

describe('direct connect client against a fake server', () => {
  it('creates a session with the official payload and bearer token', async () => {
    fake = startFakeServer()
    const serverUrl = `http://127.0.0.1:${fake.server.port}`
    const session = await createDirectConnectSession({
      serverUrl,
      authToken: TOKEN,
      cwd: '/local/dir',
      sessionKey: 'key-1',
      dangerouslySkipPermissions: true,
    })
    expect(fake.posts).toEqual([
      {
        auth: `Bearer ${TOKEN}`,
        body: {
          cwd: '/local/dir',
          session_key: 'key-1',
          permission_mode: 'bypassPermissions',
        },
      },
    ])
    expect(session).toEqual({
      config: {
        serverUrl,
        sessionId: 'sess-1',
        wsUrl: `ws://127.0.0.1:${fake.server.port}/sessions/sess-1/ws`,
        authToken: TOKEN,
      },
      workDir: '/remote/dir',
    })
  })

  it('includes the response body when session creation fails', async () => {
    fake = startFakeServer()
    const promise = createDirectConnectSession({
      serverUrl: `http://127.0.0.1:${fake.server.port}`,
      authToken: 'wrong',
      cwd: '/x',
    })
    await expect(promise).rejects.toBeInstanceOf(DirectConnectError)
    await expect(promise).rejects.toThrow(
      'Failed to create session: 401 Unauthorized — bad token',
    )
  })

  it('relays messages, permission answers and interrupts over the WebSocket', async () => {
    fake = startFakeServer()
    const { config } = await createDirectConnectSession({
      serverUrl: `http://127.0.0.1:${fake.server.port}`,
      authToken: TOKEN,
      cwd: '/x',
    })
    const messages: string[] = []
    const { promise: done, resolve } = Promise.withResolvers<void>()
    const manager: DirectConnectSessionManager =
      new DirectConnectSessionManager(config, {
        onConnected: () => manager.sendMessage('hello'),
        onMessage: message => {
          messages.push(message.type)
          if (message.type === 'result') resolve()
        },
        onPermissionRequest: (request, requestId) => {
          expect(request.tool_name).toBe('Bash')
          manager.respondToPermissionRequest(requestId, {
            behavior: 'allow',
            updatedInput: request.input,
          })
        },
      })
    manager.connect()
    await done
    manager.sendInterrupt()
    await Bun.sleep(50)
    manager.disconnect()

    expect(fake.wsAuth).toEqual([`Bearer ${TOKEN}`])
    expect(messages).toEqual(['assistant', 'result'])
    expect(fake.received.map(m => m.type)).toEqual([
      'user',
      'control_response',
      'control_request',
    ])
    expect(fake.received[0]).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'hello' },
    })
    expect(fake.received[1]).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'perm-1',
        response: { behavior: 'allow', updatedInput: { command: 'echo hi' } },
      },
    })
    expect(fake.received[2]).toMatchObject({
      type: 'control_request',
      request: { subtype: 'interrupt' },
    })
  })
})

describe('runConnectHeadless', () => {
  async function connect() {
    fake = startFakeServer()
    return (
      await createDirectConnectSession({
        serverUrl: `http://127.0.0.1:${fake.server.port}`,
        authToken: TOKEN,
        cwd: '/x',
      })
    ).config
  }

  it('prints the result text and denies permissions by default', async () => {
    const config = await connect()
    const out = captureStdout()
    let code: number
    try {
      code = await runConnectHeadless(config, 'hi', 'text')
    } finally {
      out.restore()
    }
    expect(code).toBe(0)
    expect(out.chunks.join('')).toBe('done: denied\n')
    expect(fake!.received[1]).toMatchObject({
      type: 'control_response',
      response: { response: { behavior: 'deny' } },
    })
  })

  it('streams every message as JSON lines and allows with --dangerously-skip-permissions', async () => {
    const config = await connect()
    const out = captureStdout()
    let code: number
    try {
      code = await runConnectHeadless(config, 'hi', 'stream-json', {
        dangerouslySkipPermissions: true,
      })
    } finally {
      out.restore()
    }
    expect(code).toBe(0)
    const lines = out.chunks
      .join('')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { type: string; result?: string })
    expect(lines.map(l => l.type)).toEqual(['assistant', 'result'])
    expect(lines[1]?.result).toBe('done: allowed')
  })

  it('exits 1 when the server goes away before a result', async () => {
    const out = captureStdout()
    let code: number
    try {
      code = await runConnectHeadless(
        {
          serverUrl: 'http://127.0.0.1:1',
          sessionId: 's',
          wsUrl: 'ws://127.0.0.1:1/sessions/s/ws',
        },
        'hi',
      )
    } finally {
      out.restore()
    }
    expect(code).toBe(1)
    expect(out.chunks).toEqual([])
  })
})
