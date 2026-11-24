import { afterEach, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { STDIO_FRAME_PREFIX, STDIO_HOST } from '../src/web/stdioTransport.ts'
import { FRAME_PREFIX, SERVER_HOST, startSidecar } from './sidecar.js'

const APP_ORIGIN = 'claude-app://app'

// Stands in for `claude web --stdio`: the real transport with handlers that
// echo what they were sent, plus a socket that echoes messages.
const FAKE_SERVER = `
import { serveStdio } from ${JSON.stringify(join(import.meta.dirname, '..', 'src', 'web', 'stdioTransport.ts'))}
console.log('not a frame')
serveStdio({ input: process.stdin, output: process.stdout }, {
  fetch: async (req, srv) => {
    const url = new URL(req.url)
    if (url.pathname === '/ws') {
      if (req.headers.get('origin') !== 'http://${STDIO_HOST}') return Response.json({ error: 'Forbidden' }, { status: 403 })
      srv.upgrade(req, { data: 'session' })
      return undefined
    }
    if (url.pathname === '/empty') return new Response(null, { status: 204 })
    return Response.json({
      method: req.method,
      path: url.pathname + url.search,
      host: req.headers.get('host'),
      origin: req.headers.get('origin'),
      body: await req.text(),
    })
  },
  error: err => new Response(err.message, { status: 500 }),
  websocket: {
    open: ws => ws.send('hello ' + ws.data),
    message: (ws, message) => (message === 'bye' ? ws.close(1000, 'done') : ws.send('echo ' + message)),
    close: () => {},
  },
}, { info() {}, warn() {}, error() {} })
process.stdin.once('end', () => process.exit(0))
`

const started = []
afterEach(async () => {
  await Promise.all(started.splice(0).map(s => s.stop()))
})

function start() {
  const logs = []
  const sidecar = startSidecar({
    command: process.execPath,
    args: ['-e', FAKE_SERVER],
    env: process.env,
    appOrigin: APP_ORIGIN,
    log: line => logs.push(line),
  })
  started.push(sidecar)
  return { sidecar, logs }
}

function events(sidecar, path) {
  const seen = []
  let wake
  const channel = sidecar.socket(path, (type, data, code, reason) => {
    seen.push({ type, data, code, reason })
    wake?.()
  })
  const next = async () => {
    while (!seen.length) await new Promise(resolve => (wake = resolve))
    return seen.shift()
  }
  return { channel, next }
}

describe('desktop sidecar relay', () => {
  it('uses the same framing as the server', () => {
    expect(FRAME_PREFIX).toBe(STDIO_FRAME_PREFIX)
    expect(SERVER_HOST).toBe(STDIO_HOST)
  })

  it('relays a request and presents the page origin as the server own', async () => {
    const { sidecar, logs } = start()
    await sidecar.ready
    const res = await sidecar.fetch(
      new Request(`${APP_ORIGIN}/api/x?q=1`, {
        method: 'POST',
        headers: { origin: APP_ORIGIN, 'content-type': 'text/plain' },
        body: 'payload',
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      method: 'POST',
      path: '/api/x?q=1',
      host: STDIO_HOST,
      origin: `http://${STDIO_HOST}`,
      body: 'payload',
    })
    // Another origin is passed on as it is, for the server to refuse.
    const foreign = await sidecar.fetch(new Request(`${APP_ORIGIN}/`, { method: 'POST', headers: { origin: 'http://localhost:3000' }, body: '' }))
    expect((await foreign.json()).origin).toBe('http://localhost:3000')
    const empty = await sidecar.fetch(new Request(`${APP_ORIGIN}/empty`))
    expect(empty.status).toBe(204)
    expect(logs).toContain('not a frame')
  })

  it('relays a session socket both ways and reports either side closing it', async () => {
    const { sidecar } = start()
    await sidecar.ready
    const refused = events(sidecar, '/elsewhere')
    expect(await refused.next()).toMatchObject({ type: 'close', code: 1006 })

    const a = events(sidecar, '/ws')
    expect(await a.next()).toMatchObject({ type: 'open' })
    expect(await a.next()).toMatchObject({ type: 'message', data: 'hello session' })
    a.channel.send('hi')
    expect(await a.next()).toMatchObject({ type: 'message', data: 'echo hi' })
    a.channel.send('bye')
    expect(await a.next()).toMatchObject({ type: 'close', code: 1000, reason: 'done' })

    const b = events(sidecar, '/ws')
    expect(await b.next()).toMatchObject({ type: 'open' })
    await b.next()
    b.channel.close(4000, 'page')
    expect(await b.next()).toMatchObject({ type: 'close', code: 4000, reason: 'page' })
  })

  it('stops the server by closing its pipe and fails what is still open', async () => {
    const { sidecar } = start()
    await sidecar.ready
    const open = events(sidecar, '/ws')
    expect(await open.next()).toMatchObject({ type: 'open' })
    await open.next()
    await sidecar.stop()
    expect(await open.next()).toMatchObject({ type: 'close', code: 1006 })
    expect(sidecar.fetch(new Request(`${APP_ORIGIN}/`))).rejects.toThrow('claude exited')
  })
})
