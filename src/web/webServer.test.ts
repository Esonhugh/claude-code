import { afterEach, describe, expect, it } from 'bun:test'
import { spawn } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'fs'
import { homedir, hostname, networkInterfaces, tmpdir } from 'os'
import { join } from 'path'
import type { SpawnSessionOptions } from '../server/backends/dangerousBackend.js'
import { createServerLogger } from '../server/serverLog.js'
import { SessionManager } from '../server/sessionManager.js'
import { addressKind } from './network.js'
import {
  contentSecurityPolicy,
  normalizeProjectDir,
  parsePreviewOrigin,
  startWebServer,
  type WebAsset,
  type WebServerConfig,
} from './webServer.js'

const TOKEN = 'web-test-token'

// Stands in for `claude -p` stream-json: a user message is answered with a
// result naming the text and the child's cwd. With session state events on,
// the turn is bracketed by running/idle, and a "hold" turn never ends.
// "dispatch" starts worker a1 and finishes it; "start" starts worker a2,
// which is killed with the child, as `claude -p` does; control requests succeed.
const FAKE_CHILD = `
const out = m => process.stdout.write(JSON.stringify(m) + '\\n')
const states = !!process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS
const state = s => states && out({ type: 'system', subtype: 'session_state_changed', state: s })
let buf = ''
let worker
process.on('SIGTERM', () => {
  if (worker) out({ type: 'system', subtype: 'task_notification', task_id: worker, status: 'killed' })
  process.exit(0)
})
process.stdin.on('data', chunk => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\\n')) !== -1) {
    const msg = JSON.parse(buf.slice(0, i))
    buf = buf.slice(i + 1)
    if (msg.type === 'control_request') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } })
    }
    if (msg.type === 'user') {
      const text = msg.message.content[0].text
      state('running')
      if (text === 'hold') continue
      if (text === 'start') {
        worker = 'a2'
        out({ type: 'system', subtype: 'task_started', task_id: 'a2', description: 'Worker two', prompt: 'go on', task_type: 'local_agent', spawn_depth: 1 })
      }
      if (text === 'dispatch') {
        out({ type: 'system', subtype: 'task_started', task_id: 'a1', description: 'Worker one', prompt: 'do it', task_type: 'local_agent', spawn_depth: 1 })
        out({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed', summary: 'done it', usage: { total_tokens: 1500, tool_uses: 1, duration_ms: 2000 } })
      }
      out({ type: 'result', subtype: 'success', is_error: false, result: text + ' in ' + process.cwd() })
      state('idle')
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
  /** What each child was spawned with. */
  spawned: SpawnSessionOptions[]
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
  const spawned: SpawnSessionOptions[] = []
  const manager = new SessionManager({
    spawn: (options: SpawnSessionOptions) => {
      spawned.push(options)
      return spawn(process.execPath, ['-e', FAKE_CHILD], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    },
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
    spawned,
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

  it('keeps sidebar marks and deletes transcripts behind the cookie and origin checks', async () => {
    const r = start()
    const prior = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = r.configDir
    try {
      const cookie = await signIn(r)
      const id = '99999999-2222-4333-8444-555555555555'
      const dir = join(r.configDir, 'projects', r.workspace.replace(/[^a-zA-Z0-9]/g, '-'))
      mkdirSync(dir, { recursive: true })
      const line = { type: 'user', sessionId: id, cwd: r.workspace, uuid: 'a0000000-0000-4000-8000-000000000001', message: { role: 'user', content: 'hello there' } }
      writeFileSync(join(dir, `${id}.jsonl`), JSON.stringify(line) + '\n')
      const meta = (body: unknown, opts: { sid?: string; origin?: string; cookie?: string } = {}) =>
        fetch(`${r.base}/api/sessions/${opts.sid ?? id}/meta`, {
          method: 'PATCH',
          headers: { cookie: opts.cookie ?? cookie, origin: opts.origin ?? r.origin },
          body: JSON.stringify(body),
        })

      expect((await fetch(`${r.base}/api/sidebar`)).status).toBe(401)
      expect((await meta({ pinned: true }, { cookie: '' })).status).toBe(401)
      expect((await meta({ pinned: true }, { origin: 'https://evil.example' })).status).toBe(403)
      expect((await meta({ pinned: true }, { sid: '..%2F..%2Fetc' })).status).toBe(400)
      expect((await meta({})).status).toBe(400)
      expect((await meta({ pinned: 'yes' })).status).toBe(400)
      expect((await meta({ title: '   ' })).status).toBe(400)
      expect((await meta({ extra: 1 })).status).toBe(400)
      expect((await meta({ project_id: '../x' })).status).toBe(400)
      expect((await meta({ project_id: 'p1' })).status).toBe(400)

      const pinned = await meta({ pinned: true, unread: true, title: ' Renamed ' })
      expect(pinned.status).toBe(200)
      expect(await pinned.json()).toMatchObject({ title: 'Renamed', unread: true })
      const sidebar = (await (await fetch(`${r.base}/api/sidebar`, { headers: { cookie } })).json()) as {
        sessions: { id: string; title: string; pinnedAt?: number; unread?: boolean }[]
        folders: Record<string, number>
      }
      expect(sidebar.sessions).toEqual([
        expect.objectContaining({ id, title: 'Renamed', label: 'title', unread: true, cwd: r.workspace }),
      ])
      expect(sidebar.sessions[0]!.pinnedAt).toBeNumber()
      expect(Object.keys(sidebar.folders)).toEqual([r.workspace])

      const del = (sid: string, opts: { origin?: string } = {}) =>
        fetch(`${r.base}/api/sessions/${sid}?transcript=1`, {
          method: 'DELETE',
          headers: { cookie, origin: opts.origin ?? r.origin },
        })
      expect((await del(id, { origin: 'https://evil.example' })).status).toBe(403)
      expect((await del('..%2F..%2Fetc')).status).toBe(400)
      expect((await del(id)).status).toBe(204)
      expect(existsSync(join(dir, `${id}.jsonl`))).toBe(false)
      expect((await del(id)).status).toBe(404)
      const after = (await (await fetch(`${r.base}/api/sidebar`, { headers: { cookie } })).json()) as { sessions: unknown[] }
      expect(after.sessions).toEqual([])
    } finally {
      if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prior
    }
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

  it('serves an upload while the session transcript has no messages yet', async () => {
    const r = start()
    const prior = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = r.configDir
    try {
      const cookie = await signIn(r)
      const id = '99999999-2222-4333-8444-555555555556'
      const dir = join(r.configDir, 'projects', r.workspace.replace(/[^a-zA-Z0-9]/g, '-'))
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${id}.jsonl`), JSON.stringify({ type: 'custom-title', sessionId: id, customTitle: 'New' }) + '\n')
      const saved = await fetch(`${r.base}/api/files/${id}?name=notes.txt`, {
        method: 'POST',
        headers: { cookie, origin: r.origin },
        body: 'NOTES_BODY',
      })
      const { path } = (await saved.json()) as { path: string }
      const served = await fetch(`${r.base}/api/files/${id}?path=${encodeURIComponent(path)}`, { headers: { cookie } })
      expect(served.status).toBe(200)
      expect(await served.text()).toBe('NOTES_BODY')

    } finally {
      if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prior
    }
  })

  it('answers an uncaught error with a plain JSON 500, not the debug page', async () => {
    const r = start({
      folderTrust: {
        isTrusted: () => {
          throw new Error('SECRET_DETAIL')
        },
        save: () => {},
      },
    })
    const cookie = await signIn(r)
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'web-other-')))
    const res = await fetch(`${r.base}/api/sessions`, {
      method: 'POST',
      headers: { cookie, origin: r.origin },
      body: JSON.stringify({ cwd: other }),
    })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal error' })
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

  it('creates, lists, edits and archives projects behind the API checks', async () => {
    const trusted = new Set<string>()
    const r = start({ folderTrust: { isTrusted: dir => trusted.has(dir), save: dir => trusted.add(dir) } })
    const cookie = await signIn(r)
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'web-proj-')))
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = { cookie, origin: r.origin }) =>
      fetch(`${r.base}${path}`, { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }) })

    expect((await call('GET', '/api/projects', undefined, {})).status).toBe(401)
    expect((await call('POST', '/api/projects', { name: 'x', cwd: dir }, { cookie })).status).toBe(403)
    expect((await call('GET', '/api/projects')).status).toBe(200)
    expect(await (await call('GET', '/api/projects')).json()).toEqual([])
    for (const bad of [
      { name: '', cwd: dir },
      { name: 'x', cwd: 'relative/dir' },
      { name: 'x', cwd: join(dir, 'missing') },
      { name: 'x', cwd: dir, permission_mode: 'yolo' },
      { name: 'x', cwd: dir, worker_model: '--evil' },
      { name: 'x', cwd: dir, extra: 1 },
    ]) {
      expect((await call('POST', '/api/projects', bad)).status).toBe(400)
    }

    const refused = await call('POST', '/api/projects', { name: 'Alpha', cwd: dir })
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { needs_trust: string }).needs_trust).toBe(dir)
    const created = await call('POST', '/api/projects', {
      name: ' Alpha ',
      cwd: `${dir}/./sub/..`,
      trust: true,
      instructions: 'Be brief.',
      worker_model: 'sonnet',
    })
    expect(created.status).toBe(201)
    const project = (await created.json()) as Record<string, unknown>
    expect(project).toMatchObject({
      name: 'Alpha',
      cwd: dir,
      instructions: 'Be brief.',
      worker_model: 'sonnet',
      permission_mode: 'default',
      coordinator_session_id: null,
      running: false,
    })
    expect([...trusted]).toEqual([dir])

    const id = String(project.id)
    expect((await call('PATCH', '/api/projects/not-an-id', { name: 'x' })).status).toBe(400)
    expect((await call('PATCH', `/api/projects/${crypto.randomUUID()}`, { name: 'x' })).status).toBe(404)
    expect((await call('PATCH', `/api/projects/${id}`, { cwd: '/' })).status).toBe(400)
    const patched = await call('PATCH', `/api/projects/${id}`, { name: 'Beta', worker_model: null, permission_mode: 'plan' })
    expect(await patched.json()).toMatchObject({ name: 'Beta', worker_model: null, permission_mode: 'plan', cwd: dir })

    const meta = (body: unknown) => call('PATCH', `/api/sessions/${crypto.randomUUID()}/meta`, body)
    expect(await (await meta({ project_id: id })).json()).toMatchObject({ projectId: id })

    expect((await call('DELETE', `/api/projects/${id}`)).status).toBe(204)
    expect(await (await call('GET', '/api/projects')).json()).toEqual([])
    expect((await call('PATCH', `/api/projects/${id}`, { name: 'x' })).status).toBe(404)
    expect((await meta({ project_id: id })).status).toBe(400)

    const other = (await (await call('POST', '/api/projects', { name: 'Gamma', cwd: dir })).json()) as { id: string }
    expect((await call('DELETE', `/api/projects/${other.id}?purge=1`)).status).toBe(204)
    expect((await call('DELETE', `/api/projects/${other.id}?purge=1`)).status).toBe(404)
  })

  it('starts the coordinator with its prompt and resumes it on reopen', async () => {
    const r = start()
    const cookie = await signIn(r)
    const headers = { cookie, origin: r.origin }
    const created = await fetch(`${r.base}/api/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'P', cwd: r.workspace, instructions: 'PROJECT_NOTE', worker_model: 'haiku', permission_mode: 'acceptEdits' }),
    })
    const { id } = (await created.json()) as { id: string }
    const open = async () => {
      const res = await fetch(`${r.base}/api/projects/${id}/coordinator`, { method: 'POST', headers })
      expect(res.status).toBe(200)
      return (await res.json()) as { session_id: string; work_dir: string }
    }
    const first = await open()
    expect(first.work_dir).toBe(r.workspace)
    expect(r.spawned).toHaveLength(1)
    const spawnedWith = r.spawned[0]!
    expect(spawnedWith.resume).toBeUndefined()
    expect(spawnedWith.permissionMode).toBe('acceptEdits')
    expect(spawnedWith.systemPrompt).toContain('You are a **coordinator**')
    expect(spawnedWith.appendSystemPrompt).toBe('PROJECT_NOTE')
    expect(spawnedWith.env).toEqual({
      CLAUDE_CODE_COORDINATOR_MODE: '1',
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
      CLAUDE_CODE_SUBAGENT_MODEL: 'haiku',
    })

    // Still running: the same session, no new child.
    expect((await open()).session_id).toBe(first.session_id)
    expect(r.spawned).toHaveLength(1)
    const listed = (await (await fetch(`${r.base}/api/projects`, { headers })).json()) as { coordinator_session_id: string; running: boolean }[]
    expect(listed[0]).toMatchObject({ coordinator_session_id: first.session_id, running: true })

    // Stopped before it wrote a transcript: a fresh coordinator replaces it.
    await fetch(`${r.base}/api/sessions/${first.session_id}`, { method: 'DELETE', headers })
    const second = await open()
    expect(second.session_id).not.toBe(first.session_id)
    expect(r.spawned[1]!.resume).toBeUndefined()

    // Archiving stops it.
    expect((await fetch(`${r.base}/api/projects/${id}`, { method: 'DELETE', headers })).status).toBe(204)
    expect(((await (await fetch(`${r.base}/api/sessions`, { headers })).json()) as unknown[]).length).toBe(0)
    expect((await fetch(`${r.base}/api/projects/${id}/coordinator`, { method: 'POST', headers })).status).toBe(404)
  })

  it('restarts the coordinator with new instructions or task model once its turn ends', async () => {
    const r = start()
    const cookie = await signIn(r)
    const headers = { cookie, origin: r.origin }
    const created = await fetch(`${r.base}/api/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'P', cwd: r.workspace, instructions: 'OLD' }),
    })
    const { id } = (await created.json()) as { id: string }
    const patch = (body: object) =>
      fetch(`${r.base}/api/projects/${id}`, { method: 'PATCH', headers, body: JSON.stringify(body) })
    const opened = await fetch(`${r.base}/api/projects/${id}/coordinator`, { method: 'POST', headers })
    const { session_id: sessionId } = (await opened.json()) as { session_id: string }

    const ws = new WebSocket(`${r.base.replace('http', 'ws')}/api/sessions/${sessionId}/ws`, {
      headers,
    } as unknown as string[])
    const lines: Record<string, unknown>[] = []
    ws.onmessage = e => lines.push(JSON.parse(String(e.data)))
    await new Promise(resolve => (ws.onopen = resolve))
    const say = (text: string) =>
      ws.send(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n')
    const waitFor = async (check: () => boolean) => {
      for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(10)
      expect(check()).toBe(true)
    }
    const resultSeen = (text: string) => () => lines.some(l => l.result === `${text} in ${r.workspace}`)

    // A turn is running: the restart waits for it.
    say('hold')
    await waitFor(() => lines.some(l => l.state === 'running'))
    expect((await patch({ instructions: 'NEW' })).status).toBe(200)
    await Bun.sleep(50)
    expect(r.spawned).toHaveLength(1)
    say('finish')
    await waitFor(() => r.spawned.length === 2)
    expect(r.spawned[1]).toMatchObject({ sessionId, resume: true, appendSystemPrompt: 'NEW' })

    // The same socket talks to the new process.
    say('again')
    await waitFor(resultSeen('again'))

    // Renaming leaves it alone; a new task model while idle restarts at once.
    await patch({ name: 'Q' })
    await Bun.sleep(50)
    expect(r.spawned).toHaveLength(2)
    await patch({ worker_model: 'opus' })
    await waitFor(() => r.spawned.length === 3)
    expect(r.spawned[2]!.env).toMatchObject({ CLAUDE_CODE_SUBAGENT_MODEL: 'opus' })
    expect(r.spawned[2]!.appendSystemPrompt).toBe('NEW')
    say('last')
    await waitFor(resultSeen('last'))
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })

  it('keeps the coordinator\'s tasks, model and effort in the database', async () => {
    const r = start()
    const cookie = await signIn(r)
    const headers = { cookie, origin: r.origin }
    const created = await fetch(`${r.base}/api/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'P', cwd: r.workspace }),
    })
    const { id } = (await created.json()) as { id: string }
    const opened = await fetch(`${r.base}/api/projects/${id}/coordinator`, { method: 'POST', headers })
    const { session_id: sessionId } = (await opened.json()) as { session_id: string }
    const ws = new WebSocket(`${r.base.replace('http', 'ws')}/api/sessions/${sessionId}/ws`, {
      headers,
    } as unknown as string[])
    const lines: Record<string, unknown>[] = []
    ws.onmessage = e => lines.push(JSON.parse(String(e.data)))
    await new Promise(resolve => (ws.onopen = resolve))
    const send = (m: object) => ws.send(JSON.stringify(m) + '\n')
    const waitFor = async (check: () => boolean | Promise<boolean>) => {
      for (let i = 0; i < 200 && !(await check()); i++) await Bun.sleep(10)
      expect(await check()).toBe(true)
    }
    const api = (path: string, init?: RequestInit) => fetch(`${r.base}/api/projects/${id}${path}`, { headers, ...init })

    send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'dispatch' }] } })
    await waitFor(async () => ((await (await api('/tasks')).json()) as unknown[]).length === 1)
    expect(await (await api('/tasks')).json()).toMatchObject([
      { id: 'a1', title: 'Worker one', brief: 'do it', state: 'review', tokens: 1500, duration_ms: 2000, session_id: sessionId },
    ])
    const listed = (await (await fetch(`${r.base}/api/projects`, { headers })).json()) as Record<string, unknown>[]
    expect(listed[0]).toMatchObject({ task_count: 1, running_tasks: 0, needs_you: 1 })

    // Task routes check their ids; a task with no transcript yet has an empty one.
    expect((await api('/tasks/..%2Fx/transcript')).status).toBe(400)
    expect((await api('/tasks/nosuch/transcript')).status).toBe(404)
    expect(await (await api('/tasks/a1/transcript?after=0')).json()).toEqual({ messages: [], next: 0, reset: false, tokens: 0 })
    expect((await api('/tasks/a1/review')).status).toBe(405)
    expect(await (await api('/tasks/a1/review', { method: 'POST' })).json()).toMatchObject({ state: 'done' })

    // The coordinator's model and effort are kept once it accepts them, and a restart keeps them.
    send({ type: 'control_request', request_id: 'web-model-1', request: { subtype: 'set_model', model: 'sonnet' } })
    send({ type: 'control_request', request_id: 'web-effort-1', request: { subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } } })
    await waitFor(async () => {
      const [p] = (await (await fetch(`${r.base}/api/projects`, { headers })).json()) as Record<string, unknown>[]
      return p!.coordinator_model === 'sonnet' && p!.coordinator_effort === 'high'
    })
    await api('', { method: 'PATCH', body: JSON.stringify({ instructions: 'NEW' }) })
    await waitFor(() => r.spawned.length === 2)
    expect(r.spawned[1]).toMatchObject({ resume: true, model: 'sonnet', effort: 'high', appendSystemPrompt: 'NEW' })

    // Stopping the coordinator stops what was still running.
    send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hold' }] } })
    ws.close()
    await fetch(`${r.base}/api/sessions/${sessionId}`, { method: 'DELETE', headers })
    // Reopened, it starts on the model and effort it had.
    const reopened = await fetch(`${r.base}/api/projects/${id}/coordinator`, { method: 'POST', headers })
    expect(r.spawned.at(-1)).toMatchObject({ model: 'sonnet', effort: 'high' })

    // A worker killed because the server stops can be continued after the restart.
    const next = (await reopened.json()) as { session_id: string }
    const ws2 = new WebSocket(`${r.base.replace('http', 'ws')}/api/sessions/${next.session_id}/ws`, {
      headers,
    } as unknown as string[])
    await new Promise(resolve => (ws2.onopen = resolve))
    ws2.send(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'start' }] } }) + '\n')
    await waitFor(async () => ((await (await api('/tasks')).json()) as unknown[]).length === 2)
    running.splice(running.indexOf(r), 1)
    await r.stop()
    const again = start({ configDir: r.configDir })
    const res = await fetch(`${again.base}/api/projects/${id}/tasks/a2`, { headers: { cookie: await signIn(again), origin: again.origin } })
    expect(await res.json()).toMatchObject({ state: 'stopped', stop_reason: 'restart' })
  })
})

describe('normalizeProjectDir', () => {
  it('expands ~, resolves dots and symlinks, and refuses relative or missing paths', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'web-home-')))
    mkdirSync(join(home, 'code', 'app'), { recursive: true })
    symlinkSync(join(home, 'code'), join(home, 'link'))
    expect(normalizeProjectDir('~', home)).toBe(home)
    expect(normalizeProjectDir('~/code/app/', home)).toBe(join(home, 'code', 'app'))
    expect(normalizeProjectDir(`${home}/code/../code/app`, home)).toBe(join(home, 'code', 'app'))
    expect(normalizeProjectDir(`${home}/link/app`, home)).toBe(join(home, 'code', 'app'))
    expect(normalizeProjectDir('code/app', home)).toBeUndefined()
    expect(normalizeProjectDir('~other/x', home)).toBeUndefined()
    expect(normalizeProjectDir(join(home, 'missing'), home)).toBeUndefined()
    writeFileSync(join(home, 'file.txt'), '')
    expect(normalizeProjectDir(join(home, 'file.txt'), home)).toBeUndefined()
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
