import { afterEach, describe, expect, it } from 'bun:test'
import { spawn } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { SpawnSessionOptions } from '../server/backends/dangerousBackend.js'
import { createServerLogger } from '../server/serverLog.js'
import { SessionManager } from '../server/sessionManager.js'
import { startWebServer, type WebAsset } from './webServer.js'

const TOKEN = 'web-test-token'

// Stands in for `claude -p` stream-json: a user message is answered with a
// result naming the text and the child's cwd.
const FAKE_CHILD = `
const out = m => process.stdout.write(JSON.stringify(m) + '\\n')
let buf = ''
process.stdin.on('data', chunk => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\\n')) !== -1) {
    const msg = JSON.parse(buf.slice(0, i))
    buf = buf.slice(i + 1)
    if (msg.type === 'user') {
      out({ type: 'result', subtype: 'success', is_error: false, result: msg.message.content[0].text + ' in ' + process.cwd() })
    }
  }
})
`

const assets = new Map<string, WebAsset>([
  ['/index.html', { type: 'text/html; charset=utf-8', body: '<p>app</p>' }],
  ['/assets/app.js', { type: 'text/javascript', body: 'void 0' }],
])

type Running = {
  base: string
  origin: string
  workspace: string
  uploads: string
  configDir: string
  stop: () => Promise<void>
}

const running: Running[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map(r => r.stop()))
})

function start(): Running {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'web-ws-')))
  const configDir = realpathSync(mkdtempSync(join(tmpdir(), 'web-cfg-')))
  const uploads = join(configDir, 'web', 'uploads')
  const manager = new SessionManager({
    spawn: ({ cwd }: SpawnSessionOptions) =>
      spawn(process.execPath, ['-e', FAKE_CHILD], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
  })
  const server = startWebServer(
    {
      host: '127.0.0.1',
      port: 0,
      token: TOKEN,
      cookieKey: Buffer.alloc(32, 1),
      workspace,
      uploadsDir: uploads,
      configDir,
      uploadLimits: { fileBytes: 1000, sessionBytes: 1500 },
    },
    manager,
    assets,
    createServerLogger({ write: () => {} }),
  )
  const origin = `http://127.0.0.1:${server.port}`
  const r: Running = {
    base: origin,
    origin,
    workspace,
    uploads,
    configDir,
    stop: async () => {
      server.stop(true)
      await manager.destroyAll()
    },
  }
  running.push(r)
  return r
}

async function signIn(r: Running): Promise<string> {
  const res = await fetch(`${r.base}/?token=${TOKEN}`, { redirect: 'manual' })
  expect(res.status).toBe(302)
  expect(res.headers.get('location')).toBe('/')
  const cookie = res.headers.get('set-cookie') ?? ''
  expect(cookie).toContain('HttpOnly')
  expect(cookie).toContain('SameSite=Strict')
  return cookie.split(';')[0]!
}

describe('claude web server', () => {
  it('serves the page only after the token is exchanged for a cookie', async () => {
    const r = start()
    const anonymous = await fetch(`${r.base}/`)
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get('content-security-policy')).toContain(
      "script-src 'self'",
    )
    expect((await fetch(`${r.base}/?token=wrong`)).status).toBe(401)

    const cookie = await signIn(r)
    const page = await fetch(`${r.base}/`, { headers: { cookie } })
    expect(page.status).toBe(200)
    expect(await page.text()).toBe('<p>app</p>')
    expect(page.headers.get('x-content-type-options')).toBe('nosniff')
    const js = await fetch(`${r.base}/assets/app.js`, { headers: { cookie } })
    expect(js.headers.get('content-type')).toBe('text/javascript')
    // Client-side routes fall back to the app shell.
    const route = await fetch(`${r.base}/sessions/x`, { headers: { cookie } })
    expect(await route.text()).toBe('<p>app</p>')
  })

  it('rejects a foreign Host even with a valid token', async () => {
    const r = start()
    const res = await fetch(`${r.base}/?token=${TOKEN}`, {
      redirect: 'manual',
      headers: { host: 'attacker.example' },
    })
    expect(res.status).toBe(403)
  })

  it('guards the API with cookie and same-origin checks', async () => {
    const r = start()
    const cookie = await signIn(r)
    const post = (headers: Record<string, string>) =>
      fetch(`${r.base}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: '{}',
      })
    expect((await post({ origin: r.origin })).status).toBe(401)
    expect((await post({ cookie })).status).toBe(403)
    expect(
      (await post({ cookie, origin: 'http://attacker.example' })).status,
    ).toBe(403)
    expect(
      (
        await post({
          cookie,
          origin: r.origin,
          'sec-fetch-site': 'cross-site',
        })
      ).status,
    ).toBe(403)
    const bad = await fetch(`${r.base}/api/sessions`, {
      method: 'POST',
      headers: { cookie, origin: r.origin },
      body: JSON.stringify({ cwd: 'relative/dir' }),
    })
    expect(bad.status).toBe(400)
  })

  it('creates a session in the workspace and relays stream-json over the socket', async () => {
    const r = start()
    const cookie = await signIn(r)
    const created = await fetch(`${r.base}/api/sessions`, {
      method: 'POST',
      headers: { cookie, origin: r.origin },
      body: '{}',
    })
    expect(created.status).toBe(200)
    const { session_id: id, work_dir: workDir } = (await created.json()) as {
      session_id: string
      work_dir: string
    }
    expect(workDir).toBe(r.workspace)

    const wsUrl = `${r.base.replace('http', 'ws')}/api/sessions/${id}/ws`
    const rejected = new WebSocket(wsUrl, {
      headers: { cookie, origin: 'http://attacker.example' },
    } as unknown as string[])
    const rejectedClose = await new Promise<boolean>(resolve => {
      rejected.onopen = () => resolve(false)
      rejected.onerror = () => resolve(true)
      rejected.onclose = () => resolve(true)
    })
    expect(rejectedClose).toBe(true)

    const ws = new WebSocket(wsUrl, {
      headers: { cookie, origin: r.origin },
    } as unknown as string[])
    const line = await new Promise<string>((resolve, reject) => {
      ws.onopen = () =>
        ws.send(
          JSON.stringify({
            type: 'user',
            message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          }) + '\n',
        )
      ws.onmessage = e => resolve(String(e.data))
      ws.onerror = () => reject(new Error('socket error'))
    })
    expect(JSON.parse(line)).toMatchObject({
      type: 'result',
      result: `hi in ${r.workspace}`,
    })

    const second = new WebSocket(wsUrl, {
      headers: { cookie, origin: r.origin },
    } as unknown as string[])
    const secondOpened = await new Promise<boolean>(resolve => {
      second.onopen = () => resolve(true)
      second.onerror = () => resolve(false)
      second.onclose = () => resolve(false)
    })
    expect(secondOpened).toBe(false)
    ws.close()

    const deleted = await fetch(`${r.base}/api/sessions/${id}`, {
      method: 'DELETE',
      headers: { cookie, origin: r.origin },
    })
    expect(deleted.status).toBe(204)
  })

  it('validates history ids and rename bodies', async () => {
    const r = start()
    const cookie = await signIn(r)
    const bad = await fetch(`${r.base}/api/history/..%2F..%2Fetc/messages`, {
      headers: { cookie },
    })
    expect(bad.status).toBe(400)
    const missing = await fetch(
      `${r.base}/api/history/99999999-2222-4333-8444-555555555555/messages`,
      { headers: { cookie } },
    )
    expect(missing.status).toBe(404)
    const issuers = `${r.base}/api/history/99999999-2222-4333-8444-555555555555/agent-issuers`
    expect((await fetch(`${issuers}?tool_use_id=..%2Fx`, { headers: { cookie } })).status).toBe(400)
    expect(await (await fetch(`${issuers}?tool_use_id=toolu_1`, { headers: { cookie } })).json()).toEqual({})
    const rename = await fetch(
      `${r.base}/api/history/99999999-2222-4333-8444-555555555555`,
      {
        method: 'PATCH',
        headers: { cookie, origin: r.origin },
        body: JSON.stringify({ title: '   ' }),
      },
    )
    expect(rename.status).toBe(400)
    const resume = await fetch(`${r.base}/api/sessions`, {
      method: 'POST',
      headers: { cookie, origin: r.origin },
      body: JSON.stringify({ resume: '--help' }),
    })
    expect(resume.status).toBe(400)
    const info = await fetch(`${r.base}/api/info`, { headers: { cookie } })
    expect(await info.json()).toEqual({ workspace: r.workspace })
  })

  it('uploads within the limits and serves only allowed files', async () => {
    const r = start()
    const cookie = await signIn(r)
    const created = await fetch(`${r.base}/api/sessions`, {
      method: 'POST',
      headers: { cookie, origin: r.origin },
      body: '{}',
    })
    const { session_id: id } = (await created.json()) as { session_id: string }
    const upload = (name: string, body: string) =>
      fetch(`${r.base}/api/files/${id}?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { cookie, origin: r.origin },
        body,
      })

    const saved = await upload('../../evil\u0007.txt', 'hello')
    expect(saved.status).toBe(200)
    const info = (await saved.json()) as { path: string; name: string }
    expect(info.name).toBe('evil.txt')
    expect(info.path).toBe(join(r.uploads, id, 'evil.txt'))
    expect(((await (await upload('evil.txt', 'x')).json()) as { name: string }).name).toBe(
      'evil (1).txt',
    )
    expect((await upload('big.bin', 'x'.repeat(1001))).status).toBe(413)
    expect((await upload('a.bin', 'x'.repeat(900))).status).toBe(200)
    expect((await upload('b.bin', 'x'.repeat(900))).status).toBe(413)

    const get = (path: string, headers: Record<string, string> = {}) =>
      fetch(`${r.base}/api/files/${id}?path=${encodeURIComponent(path)}`, {
        headers: { cookie, ...headers },
      })
    const served = await get(info.path)
    expect(await served.text()).toBe('hello')
    const ranged = await get(info.path, { range: 'bytes=1-3' })
    expect(ranged.status).toBe(206)
    expect(await ranged.text()).toBe('ell')

    writeFileSync(join(r.workspace, 'page.html'), '<script>alert(1)</script>')
    const page = await get(join(r.workspace, 'page.html'))
    expect(page.headers.get('content-type')).toBe('text/plain; charset=utf-8')

    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'web-out-')))
    writeFileSync(join(outside, 'secret.txt'), 'nope')
    symlinkSync(join(outside, 'secret.txt'), join(r.workspace, 'link.txt'))
    writeFileSync(join(r.workspace, '.env'), 'TOKEN=1')
    mkdirSync(join(r.configDir, 'projects'), { recursive: true })
    writeFileSync(join(r.configDir, 'projects', 'x.txt'), 'no')
    for (const path of [
      join(outside, 'secret.txt'),
      join(r.workspace, 'link.txt'),
      join(r.workspace, '..', 'x'),
      join(r.workspace, '.env'),
      join(r.configDir, 'projects', 'x.txt'),
      'relative.txt',
    ]) {
      expect((await get(path)).status).toBe(404)
    }
    const other = await fetch(
      `${r.base}/api/files/99999999-2222-4333-8444-555555555555?path=${encodeURIComponent(info.path)}`,
      { headers: { cookie } },
    )
    expect(other.status).toBe(404)
  })
})
