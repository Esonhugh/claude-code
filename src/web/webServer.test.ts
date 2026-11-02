import { afterEach, describe, expect, it } from 'bun:test'
import { spawn } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'fs'
import { homedir, hostname, networkInterfaces, tmpdir } from 'os'
import { join } from 'path'
import type { SpawnSessionOptions } from '../server/backends/dangerousBackend.js'
import { createServerLogger } from '../server/serverLog.js'
import { SessionManager } from '../server/sessionManager.js'
import { addressKind } from './network.js'
import {
  contentSecurityPolicy,
  parsePreviewOrigin,
  startWebServer,
  type WebAsset,
  type WebServerConfig,
} from './webServer.js'

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

function start(overrides: Partial<WebServerConfig> = {}): Running {
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
      ...overrides,
    },
    manager,
    assets,
    createServerLogger({ write: () => {} }),
  )
  const origin = `${overrides.tls ? 'https' : 'http'}://127.0.0.1:${server.port}`
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
    expect(await info.json()).toEqual({
      workspace: r.workspace,
      preview_origins: [],
      temp_root: join(r.configDir, 'web', 'temp'),
      home: homedir(),
    })
  })

  it('starts a temporary chat in a fresh folder under the config dir', async () => {
    const r = start()
    const cookie = await signIn(r)
    const create = async () => {
      const res = await fetch(`${r.base}/api/sessions`, {
        method: 'POST',
        headers: { cookie, origin: r.origin },
        body: JSON.stringify({ temporary: true }),
      })
      expect(res.status).toBe(200)
      return ((await res.json()) as { work_dir: string }).work_dir
    }
    const [a, b] = [await create(), await create()]
    expect(a.startsWith(join(r.configDir, 'web', 'temp', 'chat-'))).toBe(true)
    expect(b).not.toBe(a)
  })

  it('asks for trust before starting in a folder other than the workspace', async () => {
    const trusted = new Set<string>()
    const r = start({ folderTrust: { isTrusted: dir => trusted.has(dir), save: dir => trusted.add(dir) } })
    const cookie = await signIn(r)
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'web-project-')))
    const create = (body: Record<string, unknown>) =>
      fetch(`${r.base}/api/sessions`, { method: 'POST', headers: { cookie, origin: r.origin }, body: JSON.stringify(body) })
    const refused = await create({ cwd: project })
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { needs_trust: string }).needs_trust).toBe(project)
    expect(trusted.size).toBe(0)
    expect((await create({ cwd: project, trust: true })).status).toBe(200)
    expect([...trusted]).toEqual([project])
    // Trusted now; and the workspace never asks.
    expect((await create({ cwd: project })).status).toBe(200)
    expect((await create({ cwd: r.workspace })).status).toBe(200)
  })

  it('lists workspace files for @ completion without hidden files or credentials', async () => {
    const r = start()
    const cookie = await signIn(r)
    mkdirSync(join(r.workspace, 'notes'))
    mkdirSync(join(r.workspace, 'node_modules', 'x'), { recursive: true })
    mkdirSync(join(r.workspace, '.git'))
    for (const f of ['README.md', 'notes/reading.md', 'notes/server.key', '.env', '.git/HEAD', 'node_modules/x/readme.md']) {
      writeFileSync(join(r.workspace, f), 'x')
    }
    const created = await fetch(`${r.base}/api/sessions`, { method: 'POST', headers: { cookie, origin: r.origin }, body: '{}' })
    const { session_id: id } = (await created.json()) as { session_id: string }
    const list = async (q: string) =>
      ((await (await fetch(`${r.base}/api/files/${id}/list?q=${encodeURIComponent(q)}`, { headers: { cookie } })).json()) as {
        files: string[]
      }).files
    expect(await list('')).toEqual(['README.md', 'notes/reading.md'])
    expect(await list('READ')).toEqual(['README.md', 'notes/reading.md'])
    expect(await list('notes/')).toEqual(['notes/reading.md'])
    expect(await list('key')).toEqual([])
    expect((await fetch(`${r.base}/api/files/not-an-id/list?q=`, { headers: { cookie } })).status).toBe(400)
  })

  it('tells the page its preview origins and lets it frame them', async () => {
    const r = start({ previewOrigins: ['http://dev.internal:8080'] })
    const cookie = await signIn(r)
    const info = await fetch(`${r.base}/api/info`, { headers: { cookie } })
    expect((await info.json()).preview_origins).toEqual(['http://dev.internal:8080'])
    const page = await fetch(`${r.base}/`, { headers: { cookie } })
    expect(page.headers.get('content-security-policy')).toBe(
      contentSecurityPolicy(['http://dev.internal:8080']),
    )
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

  it('answers to <hostname>.local only with the local network flag', async () => {
    const name = hostname().toLowerCase().split('.')[0]
    const signInAs = (r: Running) =>
      fetch(`${r.base}/?token=${TOKEN}`, {
        redirect: 'manual',
        headers: { host: `${name}.local:${new URL(r.base).port}` },
      })
    expect((await signInAs(start())).status).toBe(403)
    const lan = start({ host: '0.0.0.0', allowLocalNetwork: true })
    expect((await signInAs(lan)).status).toBe(302)
    // The token is still required, and foreign hosts are still refused.
    expect((await fetch(`${lan.base}/`)).status).toBe(401)
    const foreign = await fetch(`${lan.base}/?token=${TOKEN}`, {
      redirect: 'manual',
      headers: { host: 'attacker.example' },
    })
    expect(foreign.status).toBe(403)
  })

  it('refuses peers outside loopback and LAN ranges', async () => {
    const publicAddress = Object.values(networkInterfaces())
      .flat()
      .find(i => i && i.family === 'IPv4' && addressKind(i.address) === 'other')
    if (!publicAddress) return
    const r = start({ host: '0.0.0.0', allowLocalNetwork: true })
    const port = new URL(r.base).port
    // Connecting to our own non-LAN address makes it the peer address.
    const res = await fetch(`http://${publicAddress.address}:${port}/?token=${TOKEN}`, {
      redirect: 'manual',
      headers: { host: `127.0.0.1:${port}` },
    })
    expect(res.status).toBe(403)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('serves https with a Secure cookie when given a certificate', async () => {
    if (!Bun.which('openssl')) return
    const dir = mkdtempSync(join(tmpdir(), 'web-tls-'))
    const cert = join(dir, 'cert.pem')
    const key = join(dir, 'key.pem')
    const made = Bun.spawnSync(
      [
        'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1',
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    )
    if (made.exitCode !== 0) return
    const r = start({ tls: { cert, key } })
    expect(r.base.startsWith('https://')).toBe(true)
    const res = await fetch(`${r.base}/?token=${TOKEN}`, {
      redirect: 'manual',
      tls: { rejectUnauthorized: false },
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('set-cookie')).toContain('; Secure')
    const plain = await fetch(`http://127.0.0.1:${new URL(r.base).port}/`).catch(
      () => undefined,
    )
    expect(plain?.status).not.toBe(200)
  })
})

describe('contentSecurityPolicy', () => {
  it('frames only blobs, loopback dev servers and the configured origins', () => {
    const loopback =
      'http://localhost:* https://localhost:* http://127.0.0.1:* https://127.0.0.1:*'
    expect(contentSecurityPolicy()).toBe(
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src blob: ${loopback}; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
    )
    expect(
      contentSecurityPolicy(['http://dev.internal:8080', 'https://grafana.lan'])
        .split('; ')
        .find(d => d.startsWith('frame-src ')),
    ).toBe(`frame-src blob: ${loopback} http://dev.internal:8080 https://grafana.lan`)
  })
})

describe('parsePreviewOrigin', () => {
  it('normalizes an http(s) origin', () => {
    expect(parsePreviewOrigin('http://dev.internal:8080')).toBe('http://dev.internal:8080')
    expect(parsePreviewOrigin('http://dev.internal:8080/')).toBe('http://dev.internal:8080')
    expect(parsePreviewOrigin('HTTPS://Grafana.LAN:443/')).toBe('https://grafana.lan')
    expect(parsePreviewOrigin('http://192.168.1.9:3000')).toBe('http://192.168.1.9:3000')
    expect(parsePreviewOrigin('http://bücher.lan')).toBe('http://xn--bcher-kva.lan')
  })

  it('refuses paths, credentials, wildcards, IPv6 literals and other schemes', () => {
    for (const value of [
      'http://[fd00::1]:3000',
      'http://dev.internal:8080/app',
      'http://dev.internal:8080/?x=1',
      'http://dev.internal:8080/?',
      'http://dev.internal:8080/#top',
      'http://user:pass@dev.internal',
      'http://user@dev.internal',
      'http://*.internal',
      '*',
      'http://dev.internal:*',
      'javascript:alert(1)',
      'data:text/html,x',
      'ftp://dev.internal',
      'ws://dev.internal',
      'dev.internal:8080',
      'http://dev internal',
      "http://dev.internal; script-src 'unsafe-inline'",
      'http://dev.internal:8080 http://evil.example',
      'http://dev.internal;frame-src',
      'http://a,b',
      "http://a'b",
      '',
    ]) {
      expect(parsePreviewOrigin(value)).toBeUndefined()
    }
  })
})
