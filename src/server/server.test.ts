import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { spawn } from 'child_process'
import { mkdtempSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { SpawnSessionOptions } from './backends/dangerousBackend.js'
import { runConnectHeadless } from './connectHeadless.js'
import {
  createDirectConnectSession,
  deleteDirectConnectSession,
} from './createDirectConnectSession.js'
import { createServerLogger } from './serverLog.js'
import { startServer } from './server.js'
import { SessionManager } from './sessionManager.js'

const TOKEN = 'server-test-token'

// Stands in for `claude -p --input-format stream-json --permission-prompt-tool
// stdio`: a user message triggers a can_use_tool request; the control_response
// produces a result naming the decision and the child's cwd.
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
      out({ type: 'control_request', request_id: 'perm-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_1' } })
    } else if (msg.type === 'control_response') {
      out({ type: 'result', subtype: 'success', is_error: false, result: msg.response.response.behavior + ' in ' + process.cwd(), stop_reason: 'end_turn', duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, modelUsage: {}, permission_denials: [], uuid: '00000000-0000-4000-8000-000000000003', session_id: 's' })
    }
  }
})
`

type Running = {
  url: string
  manager: SessionManager
  spawns: SpawnSessionOptions[]
  stop: () => Promise<void>
}

let running: Running | undefined
afterEach(async () => {
  await running?.stop()
  running = undefined
})

function start(
  options: { maxSessions?: number; idleTimeoutMs?: number; workspace?: string } = {},
): Running {
  const spawns: SpawnSessionOptions[] = []
  const logs: string[] = []
  const logger = createServerLogger({ write: chunk => logs.push(chunk) })
  const manager = new SessionManager(
    {
      spawn: opts => {
        spawns.push(opts)
        return spawn(process.execPath, ['-e', FAKE_CHILD], {
          cwd: opts.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      },
    },
    { ...options, logger },
  )
  const server = startServer(
    {
      host: '127.0.0.1',
      port: 0,
      authToken: TOKEN,
      workspace: options.workspace,
    },
    manager,
    logger,
  )
  const result: Running = {
    url: `http://127.0.0.1:${server.port}`,
    manager,
    spawns,
    stop: async () => {
      server.stop(true)
      await manager.destroyAll()
      expect(logs.join('')).not.toContain(TOKEN)
    },
  }
  running = result
  return result
}

function post(url: string, body: unknown, token = TOKEN) {
  return fetch(`${url}/sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
}

async function runHeadless(url: string, cwd: string, allow: boolean) {
  const { config, workDir } = await createDirectConnectSession({
    serverUrl: url,
    authToken: TOKEN,
    cwd,
  })
  const chunks: string[] = []
  const stdout = spyOn(process.stdout, 'write').mockImplementation(((
    chunk: string,
  ) => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stdout.write)
  try {
    const code = await runConnectHeadless(config, 'hi', 'text', {
      dangerouslySkipPermissions: allow,
    })
    return { code, output: chunks.join(''), workDir, config }
  } finally {
    stdout.mockRestore()
  }
}

const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), 'dc-server-')))

describe('claude server', () => {
  it('rejects requests without the bearer token', async () => {
    const { url, spawns } = start()
    expect((await post(url, { cwd: '/' }, 'wrong')).status).toBe(401)
    const noAuth = await fetch(`${url}/sessions`, { method: 'POST', body: '{}' })
    expect(noAuth.status).toBe(401)
    const ws = await fetch(`${url}/sessions/x/ws`)
    expect(ws.status).toBe(401)
    expect(spawns).toEqual([])
  })

  it('validates the request body', async () => {
    const { url, spawns } = start()
    const badMode = await post(url, { cwd: '/', permission_mode: 'yolo' })
    expect(badMode.status).toBe(400)
    const badCwd = await post(url, { cwd: '/definitely/not/here' })
    expect(badCwd.status).toBe(400)
    expect(await badCwd.text()).toContain('--workspace')
    expect(spawns).toEqual([])
  })

  it('runs a turn end to end, relaying can_use_tool and the client answer', async () => {
    const { url, spawns, manager } = start()
    const dir = tempDir()
    const denied = await runHeadless(url, dir, false)
    expect(denied).toMatchObject({
      code: 0,
      output: `deny in ${dir}\n`,
      workDir: dir,
    })
    const allowed = await runHeadless(url, dir, true)
    expect(allowed.output).toBe(`allow in ${dir}\n`)
    expect(spawns.map(s => s.cwd)).toEqual([dir, dir])
    expect(spawns[0]?.sessionId).toBe(denied.config.sessionId)

    expect(manager.get(allowed.config.sessionId)).toBeDefined()
    await deleteDirectConnectSession(allowed.config)
    expect(manager.get(allowed.config.sessionId)).toBeUndefined()
  })

  it('passes permission_mode through and reuses a session by session_key', async () => {
    const { url, spawns } = start()
    const first = await (
      await post(url, { cwd: '/', permission_mode: 'plan', session_key: 'k' })
    ).json()
    const second = await (await post(url, { cwd: '/', session_key: 'k' })).json()
    expect(second.session_id).toBe(first.session_id)
    expect(first.ws_url).toBe(`${url.replace('http', 'ws')}/sessions/${first.session_id}/ws`)
    expect(spawns).toEqual([
      { sessionId: first.session_id, cwd: '/', permissionMode: 'plan' },
    ])
  })

  it('falls back to --workspace when the client cwd does not exist here', async () => {
    const workspace = tempDir()
    const { url } = start({ workspace })
    const body = await (await post(url, { cwd: '/no/such/dir' })).json()
    expect(body.work_dir).toBe(workspace)
  })

  it('enforces --max-sessions', async () => {
    const { url } = start({ maxSessions: 1 })
    expect((await post(url, { cwd: '/' })).status).toBe(200)
    const second = await post(url, { cwd: '/' })
    expect(second.status).toBe(503)
    expect(await second.text()).toContain('Maximum number of sessions (1)')
  })

  it('allows one attached client per session and deletes sessions', async () => {
    const { url, manager } = start()
    const { session_id: id, ws_url: wsUrl } = await (
      await post(url, { cwd: '/' })
    ).json()
    const ws = new WebSocket(wsUrl, {
      headers: { authorization: `Bearer ${TOKEN}` },
    } as unknown as string[])
    await new Promise(resolve => ws.addEventListener('open', resolve))
    await Bun.sleep(20)
    const busy = await fetch(`${url}/sessions/${id}/ws`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(busy.status).toBe(409)

    const closed = new Promise<number>(resolve =>
      ws.addEventListener('close', event => resolve(event.code)),
    )
    const del = await fetch(`${url}/sessions/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(del.status).toBe(204)
    expect(await closed).toBe(1000)
    expect(manager.get(id)).toBeUndefined()
  })

  it('stops detached sessions after the idle timeout', async () => {
    const { url, manager } = start({ idleTimeoutMs: 50 })
    const { session_id: id } = await (await post(url, { cwd: '/' })).json()
    expect(manager.get(id)?.status).toBe('detached')
    for (let i = 0; i < 100 && manager.get(id); i++) await Bun.sleep(20)
    expect(manager.get(id)).toBeUndefined()
  })
})
