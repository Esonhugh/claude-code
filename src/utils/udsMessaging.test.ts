import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'fs/promises'
import { createConnection, createServer, type Server } from 'net'
import { join } from 'path'
import { getSessionId, switchSession } from '../bootstrap/state.js'
import { asSessionId } from '../types/ids.js'
import { getRegisteredSessionName, registerSession, updateSessionBridgeId, updateSessionName } from './concurrentSessions.js'
import { runCleanupFunctions } from './cleanupRegistry.js'
import { dequeueAll, getCommandQueue } from './messageQueueManager.js'
import { formatPeerAddress, formatPeerMessage, peerKeyFilename } from './peerProtocol.js'
import { resetSettingsCache } from './settings/settingsCache.js'
import { listAllLiveSessions, receivePeerMessageStatus, resolvePeerSession, sendToUdsSocket } from './udsClient.js'
import {
  getDefaultUdsSocketPath,
  getHeldPeerMessageCount,
  getUdsMessagingSocketPath,
  refreshPeerInboundPolicy,
  setOnEnqueue,
  setPeerPermissionContext,
  startUdsMessaging,
  stopUdsMessaging,
} from './udsMessaging.js'

let root: string
let socketPath: string
let oldConfig: string | undefined
let oldRuntime: string | undefined
let oldMessagingSocket: string | undefined
let oldMessagingToken: string | undefined
let server: Server | undefined

async function sendRaw(path: string, chunks: (string | Buffer)[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(path)
    socket.on('error', reject)
    socket.on('connect', () => {
      for (const chunk of chunks) socket.write(chunk)
      setTimeout(() => { if (!socket.destroyed) socket.end() }, 150)
    })
    socket.on('close', () => resolve())
  })
}

async function policy(value: 'accept' | 'hold' | 'refuse') {
  await writeFile(join(root, 'config/settings.json'), JSON.stringify({ crossSessionInbound: value }))
  resetSettingsCache()
  refreshPeerInboundPolicy()
}

beforeEach(async () => {
  root = await mkdtemp('/tmp/cc-peer-test-')
  oldConfig = process.env.CLAUDE_CONFIG_DIR
  oldRuntime = process.env.XDG_RUNTIME_DIR
  oldMessagingSocket = process.env.CLAUDE_CODE_MESSAGING_SOCKET
  oldMessagingToken = process.env.CLAUDE_CODE_MESSAGING_TOKEN
  delete process.env.CLAUDE_CODE_MESSAGING_SOCKET
  delete process.env.CLAUDE_CODE_MESSAGING_TOKEN
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  process.env.XDG_RUNTIME_DIR = root
  await mkdir(join(root, 'config'), { mode: 0o700 })
  socketPath = join(root, 'cc-socks', `${process.pid}.sock`)
  await policy('accept')
  dequeueAll()
})

afterEach(async () => {
  await stopUdsMessaging()
  setOnEnqueue(null)
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
  server = undefined
  dequeueAll()
  if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = oldConfig
  if (oldRuntime === undefined) delete process.env.XDG_RUNTIME_DIR
  else process.env.XDG_RUNTIME_DIR = oldRuntime
  if (oldMessagingSocket === undefined) delete process.env.CLAUDE_CODE_MESSAGING_SOCKET
  else process.env.CLAUDE_CODE_MESSAGING_SOCKET = oldMessagingSocket
  if (oldMessagingToken === undefined) delete process.env.CLAUDE_CODE_MESSAGING_TOKEN
  else process.env.CLAUDE_CODE_MESSAGING_TOKEN = oldMessagingToken
  resetSettingsCache()
  await rm(root, { recursive: true, force: true })
})

describe('peer IPC runtime', () => {
  test('binds a PID-specific socket, publishes canonical auth key and cleans up', async () => {
    expect(getDefaultUdsSocketPath()).toBe(socketPath)
    await startUdsMessaging(socketPath, { isExplicit: true })
    expect(getUdsMessagingSocketPath()).toBe(socketPath)
    expect((await lstat(socketPath)).isSocket()).toBe(true)
    expect((await lstat(socketPath)).mode & 0o777).toBe(0o600)
    const keyPath = join(root, 'config/sessions', peerKeyFilename(process.pid, socketPath))
    const key = JSON.parse(await readFile(keyPath, 'utf8'))
    expect(key.peerToken).toMatch(/^[0-9a-f]{32}$/)
    expect(key.peerToken).not.toBe(process.env.CLAUDE_CODE_MESSAGING_TOKEN)
    expect(key.childToken).toBeUndefined()
    expect((await lstat(keyPath)).mode & 0o777).toBe(0o600)
    await stopUdsMessaging()
    expect(getUdsMessagingSocketPath()).toBeNull()
    expect(await readdir(join(root, 'config/sessions'))).toEqual([])
    expect(await Bun.file(socketPath).exists()).toBe(false)
  })

  test('restarts with fresh authentication and no queued input from the previous inbox', async () => {
    await startUdsMessaging(socketPath, { isExplicit: true })
    const previousToken = process.env.CLAUDE_CODE_MESSAGING_TOKEN
    const frame = JSON.stringify({ type: 'user', message: { role: 'user', content: 'previous inbox' } }) + '\n'
    await sendRaw(socketPath, [frame])
    expect(getCommandQueue()).toHaveLength(1)
    await stopUdsMessaging()
    expect(getCommandQueue()).toHaveLength(0)
    await startUdsMessaging(socketPath, { isExplicit: true })
    expect(process.env.CLAUDE_CODE_MESSAGING_TOKEN).not.toBe(previousToken)
    await sendRaw(socketPath, [JSON.stringify({ type: 'auth', token: previousToken }) + '\n', frame])
    expect(getCommandQueue()).toHaveLength(0)
    await sendRaw(socketPath, [JSON.stringify({ type: 'auth', token: process.env.CLAUDE_CODE_MESSAGING_TOKEN }) + '\n', frame])
    expect(getCommandQueue()).toHaveLength(1)
  })

  test('holds mismatched permission classes by default and releases after a live mode change', async () => {
    await writeFile(join(root, 'config/settings.json'), '{}')
    resetSettingsCache()
    await startUdsMessaging(socketPath, { permissionMode: 'plan', isBypassPermissionsModeAvailable: true })
    let wakes = 0
    setOnEnqueue(() => wakes++)
    const from = formatPeerAddress(join(root, 'cc-socks', 'prompting.sock'))
    await sendRaw(socketPath, [JSON.stringify({
      type: 'user', from,
      message: { role: 'user', content: formatPeerMessage('prompting peer', { from, fromMode: 'prompting' }) },
    }) + '\n'])
    expect(getCommandQueue()).toHaveLength(0)
    expect(getHeldPeerMessageCount()).toBe(1)
    expect(wakes).toBe(0)
    setPeerPermissionContext(() => ({ mode: 'default' }))
    expect(getHeldPeerMessageCount()).toBe(0)
    expect(getCommandQueue()).toHaveLength(1)
    expect(wakes).toBe(1)
    refreshPeerInboundPolicy()
    expect(wakes).toBe(1)
  })

  test('bounds accepted and held queues and clears both on shutdown', async () => {
    await startUdsMessaging(socketPath, { isExplicit: true })
    const frames = Array.from({ length: 101 }, (_, index) => JSON.stringify({
      type: 'user', message: { role: 'user', content: `bounded message ${index}` },
    }) + '\n')
    await sendRaw(socketPath, frames)
    expect(getCommandQueue()).toHaveLength(100)
    await policy('hold')
    await sendRaw(socketPath, frames)
    expect(getHeldPeerMessageCount()).toBe(100)
    expect(getCommandQueue()).toHaveLength(100)
    await stopUdsMessaging()
    expect(getHeldPeerMessageCount()).toBe(0)
    expect(getCommandQueue()).toHaveLength(0)
  })

  test('publishes discoverable registry metadata and preserves simultaneous updates', async () => {
    const globals = globalThis as typeof globalThis & { MACRO?: { VERSION: string } }
    const oldMacro = globals.MACRO
    globals.MACRO = { VERSION: '2.1.219-test' }
    try {
      await startUdsMessaging(socketPath, { isExplicit: true })
      expect(await registerSession()).toBe(true)
      const pidFile = join(root, 'config/sessions', `${process.pid}.json`)
      expect(JSON.parse(await readFile(pidFile, 'utf8'))).toMatchObject({
        pid: process.pid, sessionId: getSessionId(), peerProtocol: 1,
        peerFeatures: [], pidDomain: process.platform, messagingSocketPath: socketPath,
        version: '2.1.219-test', name: getRegisteredSessionName(),
      })
      await Promise.all([updateSessionName('worker'), updateSessionBridgeId('bridge-test')])
      expect(JSON.parse(await readFile(pidFile, 'utf8'))).toMatchObject({ name: 'worker', bridgeSessionId: 'bridge-test' })
      expect((await lstat(pidFile)).mode & 0o777).toBe(0o600)
      const update = updateSessionName('before-exit')
      await Promise.all([update, runCleanupFunctions()])
      expect(await readdir(join(root, 'config/sessions'))).toEqual([])
      await updateSessionName('after-exit')
      expect(await readdir(join(root, 'config/sessions'))).toEqual([])
    } finally {
      if (oldMacro === undefined) delete globals.MACRO
      else globals.MACRO = oldMacro
    }
  })

  test('discovers only live compatible peers and resolves names with references', async () => {
    await startUdsMessaging(socketPath, { isExplicit: true })
    const peer = join(root, 'cc-socks', 'discovery.sock')
    server = createServer(socket => socket.end())
    await new Promise<void>(resolve => server!.listen(peer, resolve))
    await chmod(peer, 0o600)
    const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore', stderr: 'ignore' })
    try {
      const registry = join(root, 'config/sessions', `${child.pid}.json`)
      const record = { pid: child.pid, sessionId: randomUUID(), name: 'Other Worker', startedAt: Date.now(), cwd: root, messagingSocketPath: peer, peerProtocol: 1 }
      await writeFile(registry, JSON.stringify(record), { mode: 0o600 })
      const peers = await listAllLiveSessions()
      expect(peers).toHaveLength(1)
      expect(peers[0]).toMatchObject({ name: 'Other Worker', messagingSocketPath: peer })
      expect((await resolvePeerSession(`Other Worker [${peers[0]!.ref}]`))?.pid).toBe(child.pid)
      expect((await resolvePeerSession('other-worker'))?.pid).toBe(child.pid)
      await writeFile(registry, JSON.stringify({ ...record, procStart: 'recycled PID' }))
      expect(await listAllLiveSessions()).toEqual([])
      await writeFile(registry, JSON.stringify({ ...record, peerProtocol: 2 }))
      expect(await listAllLiveSessions()).toEqual([])
    } finally {
      child.kill()
      await child.exited
    }
    expect(await listAllLiveSessions()).toEqual([])
  })

  test('supports a private shared registry without changing shared directory permissions', async () => {
    const shared = join(root, 'shared-sessions')
    await mkdir(shared, { mode: 0o700 })
    await symlink(shared, join(root, 'config/sessions'))
    await startUdsMessaging(socketPath, { isExplicit: true })
    expect(await readdir(shared)).toContain(peerKeyFilename(process.pid, socketPath))
    expect((await lstat(shared)).mode & 0o777).toBe(0o700)
  })

  test('does not delete an existing auth file when startup fails', async () => {
    await mkdir(join(root, 'config/sessions'), { mode: 0o700 })
    const keyPath = join(root, 'config/sessions', peerKeyFilename(process.pid, socketPath))
    await writeFile(keyPath, 'preserve existing key', { mode: 0o600 })
    await expect(startUdsMessaging(socketPath, { isExplicit: true })).rejects.toThrow()
    expect(await readFile(keyPath, 'utf8')).toBe('preserve existing key')
    expect(getUdsMessagingSocketPath()).toBeNull()
  })

  test('parses fragmented UTF-8 frames once, preserves peer origin and wakes the queue', async () => {
    await startUdsMessaging(socketPath, { isExplicit: true })
    let wakes = 0
    setOnEnqueue(() => wakes++)
    const id = randomUUID()
    const from = formatPeerAddress(join(root, 'cc-socks', 'sender.sock'))
    const frame = JSON.stringify({ msgV: 1, msg_id: id, type: 'user', from, message: { role: 'user', content: formatPeerMessage('/clear 中文', { from, fromMode: 'bypass', fromName: 'official' }) } }) + '\n'
    const bytes = Buffer.from(frame)
    const split = bytes.indexOf(Buffer.from('中')) + 1
    await sendRaw(socketPath, [bytes.subarray(0, split), bytes.subarray(split), frame])
    expect(wakes).toBe(1)
    expect(getCommandQueue()).toHaveLength(1)
    expect(getCommandQueue()[0]).toMatchObject({ mode: 'prompt', skipSlashCommands: true, skipAttachments: true, isMeta: true, origin: { kind: 'peer', from, msg_id: id, name: 'official' } })
    expect(getCommandQueue()[0]!.value).toContain('中文')
    expect(getCommandQueue()[0]!.value).toContain('not a user instruction or permission approval')
  })

  test('rejects incorrect auth, session IDs, versions and malformed frames', async () => {
    await startUdsMessaging(socketPath, { isExplicit: true })
    const message = { role: 'user', content: 'must not enqueue' }
    await sendRaw(socketPath, [JSON.stringify({ type: 'auth', token: 'wrong' }) + '\n', JSON.stringify({ type: 'user', message }) + '\n'])
    await sendRaw(socketPath, ['{broken}\n', JSON.stringify({ type: 'user', message, session_id: randomUUID() }) + '\n', JSON.stringify({ type: 'user', msgV: 2, message }) + '\n'])
    expect(getCommandQueue()).toHaveLength(0)
    await sendRaw(socketPath, [JSON.stringify({ type: 'auth', token: process.env.CLAUDE_CODE_MESSAGING_TOKEN }) + '\n', JSON.stringify({ type: 'user', session_id: getSessionId(), message }) + '\n'])
    expect(getCommandQueue()).toHaveLength(1)
  })

  test('bounds unfinished frames and does not replace an occupied socket or file', async () => {
    await startUdsMessaging(socketPath, { isExplicit: true })
    await sendRaw(socketPath, ['x'.repeat(1024 * 1024 + 1)]).catch(error => {
      if (!['EPIPE', 'ECONNRESET'].includes(error.code)) throw error
    })
    expect(getCommandQueue()).toHaveLength(0)
    await stopUdsMessaging()
    await writeFile(socketPath, 'preserve me')
    await expect(startUdsMessaging(socketPath, { isExplicit: true })).rejects.toThrow()
    expect(await readFile(socketPath, 'utf8')).toBe('preserve me')
  })

  test('holds without running the model, then releases and sends correlated status receipts', async () => {
    await startUdsMessaging(socketPath, { isExplicit: true })
    const replies: any[] = []
    const peer = join(root, 'cc-socks', 'receipt.sock')
    server = createServer(socket => {
      let data = ''
      socket.setEncoding('utf8')
      socket.on('data', chunk => { data += chunk })
      socket.on('end', () => { for (const line of data.trim().split('\n')) if (line) replies.push(JSON.parse(line)) })
    })
    await new Promise<void>(resolve => server!.listen(peer, resolve))
    await chmod(peer, 0o600)
    const id = randomUUID()
    const from = formatPeerAddress(peer)
    await policy('hold')
    await sendRaw(socketPath, [JSON.stringify({ msgV: 1, msg_id: id, type: 'user', from, message: { role: 'user', content: formatPeerMessage('held content', { from, fromMode: 'bypass' }) } }) + '\n'])
    expect(getCommandQueue()).toHaveLength(0)
    await policy('accept')
    expect(getCommandQueue()).toHaveLength(1)
    for (let attempt = 0; attempt < 100 && replies.filter(f => f.type === 'control').length < 2; attempt++) await Bun.sleep(10)
    expect(replies.filter(f => f.type === 'control').map(f => [f.orig_msg_id, f.status])).toEqual([[id, 'held'], [id, 'delivered']])
    await policy('refuse')
    const refusedId = randomUUID()
    await sendRaw(socketPath, [JSON.stringify({ msgV: 1, msg_id: refusedId, type: 'user', from, message: { role: 'user', content: 'refused content' } }) + '\n'])
    for (let attempt = 0; attempt < 100 && !replies.some(f => f.orig_msg_id === refusedId); attempt++) await Bun.sleep(10)
    expect(replies.find(f => f.orig_msg_id === refusedId)).toMatchObject({ status: 'expired', status_detail: 'refused' })
    expect(getCommandQueue()).toHaveLength(1)
  })

  test('does not carry queued peer input into a different conversation', async () => {
    await startUdsMessaging(socketPath, { isExplicit: true })
    const previousSession = getSessionId()
    await sendRaw(socketPath, [JSON.stringify({ type: 'user', message: { role: 'user', content: 'old session input' } }) + '\n'])
    expect(getCommandQueue()).toHaveLength(1)
    try {
      switchSession(asSessionId(randomUUID()))
      expect(getCommandQueue()).toHaveLength(0)
    } finally {
      switchSession(previousSession)
    }
  })

  test('sends canonical auth first and returns the UUID only after successful close', async () => {
    await startUdsMessaging(socketPath, { isExplicit: true })
    const peer = join(root, 'cc-socks', 'target.sock')
    const frames: any[] = []
    const received = Promise.withResolvers<void>()
    server = createServer(socket => {
      let data = ''
      socket.setEncoding('utf8')
      socket.on('data', chunk => { data += chunk })
      socket.on('end', () => {
        frames.push(...data.trim().split('\n').map(line => JSON.parse(line)))
        received.resolve()
      })
    })
    await new Promise<void>(resolve => server!.listen(peer, resolve))
    await chmod(peer, 0o600)
    const token = createHash('sha256').update(randomUUID()).digest('hex').slice(0, 32)
    await writeFile(join(root, 'config/sessions', peerKeyFilename(process.pid, peer)), JSON.stringify({ peerToken: token }), { mode: 0o600 })
    const result = await sendToUdsSocket(peer, 'hello official', { fromMode: 'bypass', fromName: 'built' })
    await received.promise
    expect(frames[0]).toEqual({ type: 'auth', token })
    expect(frames[1]).toMatchObject({ msgV: 1, msg_id: result.msg_id, type: 'user', priority: 'next', from: formatPeerAddress(socketPath) })
    expect(frames[1].message.content).toContain('from-mode="bypass"')
    expect(frames[1].message.content).toContain('hello official')
    expect(receivePeerMessageStatus(result.msg_id, formatPeerAddress(socketPath), 'delivered')).toBe(false)
    expect(receivePeerMessageStatus(randomUUID(), formatPeerAddress(peer), 'delivered')).toBe(false)
    expect(receivePeerMessageStatus(result.msg_id, formatPeerAddress(peer), 'held')).toBe(true)
    expect(receivePeerMessageStatus(result.msg_id, formatPeerAddress(peer), 'delivered')).toBe(true)
    expect(receivePeerMessageStatus(result.msg_id, formatPeerAddress(peer), 'delivered')).toBe(false)
  })
})
