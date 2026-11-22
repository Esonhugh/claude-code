import { afterAll, expect, test } from 'bun:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
const { connectToServer } = await import('./client.js')

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: req =>
    new URL(req.url).pathname === '/missing'
      ? new Response('not here', { status: 404 })
      : new Response('forced status', { status: 500 }),
})
afterAll(() => server.stop(true))

const connect = (path: string) =>
  connectToServer(`status${path.replace('/', '-')}`, {
    type: 'http',
    url: `http://127.0.0.1:${server.port}${path}`,
    scope: 'local',
  })

// Official 2.1.329.
test('an HTTP server that answers 404 is reported as a wrong URL', async () => {
  expect(await connect('/missing')).toMatchObject({
    type: 'failed',
    error: `MCP endpoint not found at http://127.0.0.1:${server.port}. Check the URL in your MCP config.`,
  })
})

test('an HTTP server that answers 500 is reported with its status and body', async () => {
  expect(await connect('/broken')).toMatchObject({
    type: 'failed',
    error: 'HTTP 500: Error POSTing to endpoint: forced status',
  })
})
