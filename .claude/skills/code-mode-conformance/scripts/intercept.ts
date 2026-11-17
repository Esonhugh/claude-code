// L3b loopback interceptor: an HTTP CONNECT proxy for the official binary.
//
// CONNECT to a host in INTERCEPT_HOSTS is spliced into a local HTTPS server
// that presents the leaf certificate (the CA reaches the client only through
// NODE_EXTRA_CA_CERTS). Every other CONNECT and every plain proxy request gets
// 403: nothing is forwarded off this machine.
//
// Inside the HTTPS server, POST /v1/messages* goes to mock-api.ts on MOCK_PORT,
// POST /api/eval/<clientKey> returns a remoteEval payload holding only the
// features in FAKE_FEATURES, GET paths in STUBS get a minimal valid body, and
// every other path is 404. Each request is one
// JSONL line (method, host, path, status, bytes); no headers or bodies are kept.
//
// env: PORT (proxy), MOCK_PORT, CA_DIR (leaf.crt, leaf.key), INTERCEPT_JSONL,
//      FAKE_FEATURES (JSON object, default {"tengu_rustling_blossom":true})
import { appendFileSync, readFileSync } from 'fs'
import { connect, createServer, type Socket } from 'net'

export const INTERCEPT_HOSTS = new Set(['api.anthropic.com', 'cdn.growthbook.io'])

/** The remoteEval body GrowthBook's client reads: each feature as {value}. */
export function evalPayload(features: Record<string, unknown>): object {
  return { features: Object.fromEntries(Object.entries(features).map(([k, v]) => [k, { value: v }])) }
}

/** Minimal bodies for startup reads the official binary needs to see answered. */
export const STUBS: Record<string, object> = {
  // An empty org policy: no restrictions, no compliance taints (schema K1o in 2.1.325).
  '/api/claude_code/policy_limits': { restrictions: {}, compliance_taints: [] },
}

export type Route = 'messages' | 'eval' | 'stub' | 'none'
export function route(method: string, path: string): Route {
  if (method === 'POST' && /^\/v1\/messages(\/count_tokens)?(\?|$)/.test(path)) return 'messages'
  if (method === 'POST' && /^\/api\/eval\/[\w-]+$/.test(path)) return 'eval'
  if (method === 'GET' && path in STUBS) return 'stub'
  return 'none'
}

function serve(): void {
  const port = Number(process.env.PORT ?? 47210)
  const mockPort = Number(process.env.MOCK_PORT ?? 47211)
  const caDir = process.env.CA_DIR ?? '/tmp/cmx/conformance/official/ca'
  const jsonl = process.env.INTERCEPT_JSONL ?? '/tmp/cmx/conformance/official/intercept.jsonl'
  const features = JSON.parse(process.env.FAKE_FEATURES ?? '{"tengu_rustling_blossom":true}')
  const log = (r: object) => appendFileSync(jsonl, JSON.stringify({ t: Date.now(), ...r }) + '\n')

  const https = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    tls: { cert: readFileSync(`${caDir}/leaf.crt`, 'utf8'), key: readFileSync(`${caDir}/leaf.key`, 'utf8') },
    async fetch(req) {
      const url = new URL(req.url)
      const host = (req.headers.get('host') ?? url.host).replace(/:\d+$/, '')
      const path = url.pathname + url.search
      const kind = route(req.method, url.pathname)
      let res: Response
      if (kind === 'messages') {
        const headers = new Headers(req.headers)
        headers.delete('host')
        const upstream = await fetch(`http://127.0.0.1:${mockPort}${path}`, {
          method: 'POST',
          headers,
          body: await req.arrayBuffer(),
        })
        res = new Response(upstream.body, { status: upstream.status, headers: upstream.headers })
      } else if (kind === 'stub') {
        res = Response.json(STUBS[url.pathname])
      } else if (kind === 'eval') {
        res = Response.json(evalPayload(features))
      } else {
        res = new Response('not intercepted', { status: 404 })
      }
      const bytes = Number(req.headers.get('content-length') ?? 0)
      log({ kind: 'https', method: req.method, host, path: url.pathname, route: kind, status: res.status, bytes })
      return res
    },
  })

  const proxy = createServer((client: Socket) => {
    client.once('data', head => {
      const line = head.toString('latin1').split('\r\n', 1)[0] ?? ''
      const m = /^CONNECT ([^:\s]+):(\d+) HTTP\/1\.[01]$/.exec(line)
      if (!m || !INTERCEPT_HOSTS.has(m[1]!)) {
        log({ kind: 'proxy', refused: line.replace(/\?.*$/, '').slice(0, 200) })
        client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
        return
      }
      log({ kind: 'connect', host: m[1], port: Number(m[2]) })
      const inner = connect(https.port!, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        client.pipe(inner)
        inner.pipe(client)
      })
      inner.on('error', () => client.destroy())
      client.on('error', () => inner.destroy())
    })
    client.on('error', () => {})
  })
  proxy.listen(port, '127.0.0.1', () => console.log(`intercept up on 127.0.0.1:${port} (tls ${https.port})`))
}

if (import.meta.main) serve()
