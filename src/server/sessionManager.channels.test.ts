import { afterEach, expect, it } from 'bun:test'
import { spawn } from 'child_process'
import { tmpdir } from 'os'
import { channelKey, SessionManager } from './sessionManager.js'

// Answers mcp_status with one connected server, channel_enable for "bad" with an error, the rest with success.
const CHILD = `
let buf = ''
process.stdin.on('data', chunk => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\\n')) !== -1) {
    const msg = JSON.parse(buf.slice(0, i))
    buf = buf.slice(i + 1)
    if (msg.type === 'user') setTimeout(() => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success' }) + '\\n'), 200)
    if (msg.type !== 'control_request') continue
    const r = msg.request
    const response = r.subtype === 'mcp_status' ? { mcpServers: [{ name: 'plugin:fakechat:fakechat', status: 'connected' }] } : {}
    const failed = r.subtype === 'channel_enable' && r.serverName === 'bad'
    process.stdout.write(JSON.stringify({ type: 'control_response', response: failed
      ? { subtype: 'error', request_id: msg.request_id, error: 'EADDRINUSE' }
      : { subtype: 'success', request_id: msg.request_id, response } }) + '\\n')
  }
})
`

const managers: SessionManager[] = []
afterEach(async () => {
  await Promise.all(managers.splice(0).map(m => m.destroyAll()))
})

let spawns = 0
function manager() {
  const m = new SessionManager({ spawn: () => (spawns++, spawn(process.execPath, ['-e', CHILD], { stdio: ['pipe', 'pipe', 'pipe'] })) })
  managers.push(m)
  return m
}

it('names a channel the same from --channels and from channel_enable', () => {
  expect(channelKey('plugin:fakechat@claude-plugins-official')).toBe('plugin:fakechat')
  expect(channelKey('plugin:fakechat:fakechat')).toBe('plugin:fakechat')
  expect(channelKey('localdev')).toBe('localdev')
})

it('tracks which sessions listen on a channel, and answers its own requests without relaying them', async () => {
  const m = manager()
  const a = m.create({ cwd: tmpdir(), channels: ['plugin:fakechat@m'] })
  const b = m.create({ cwd: tmpdir() })
  const relayed: string[] = []
  m.attach(b.id, { send: line => relayed.push(line), close: () => {} })

  const status = await m.request(a.id, { subtype: 'mcp_status' })
  expect(status).toMatchObject({ subtype: 'success', response: { mcpServers: [{ name: 'plugin:fakechat:fakechat' }] } })
  expect(m.channelSessions('plugin:fakechat').map(s => s.id)).toEqual([a.id])

  m.write(b.id, JSON.stringify({ type: 'control_request', request_id: 'r1', request: { subtype: 'channel_enable', serverName: 'bad' } }))
  m.write(b.id, JSON.stringify({ type: 'control_request', request_id: 'r2', request: { subtype: 'channel_enable', serverName: 'plugin:fakechat:fakechat' } }))
  await m.request(b.id, { subtype: 'mcp_status' })
  // The page's own responses reach it; the server's does not.
  expect(relayed.map(l => JSON.parse(l).response.request_id)).toEqual(['r1', 'r2'])
  expect(m.channelSessions('bad')).toEqual([])
  expect(m.channelSessions('plugin:fakechat').map(s => s.id)).toEqual([a.id, b.id])
})

it('restarts a session without state events once its turn has a result', async () => {
  const m = manager()
  const a = m.create({ cwd: tmpdir() })
  const before = spawns
  m.write(a.id, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }))
  expect(m.restart(a.id, { flags: { channels: ['plugin:fakechat@m'] } })).toBe('pending')
  await Bun.sleep(50)
  expect(spawns).toBe(before)
  for (let i = 0; i < 100 && spawns === before; i++) await Bun.sleep(20)
  expect(spawns).toBe(before + 1)
  expect(m.current(a.id)?.channels).toEqual(['plugin:fakechat@m'])
  expect(m.channelSessions('plugin:fakechat').map(s => s.id)).toEqual([a.id])
})
