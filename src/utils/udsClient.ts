import { randomUUID } from 'crypto'
import { lstat, readdir, readFile } from 'fs/promises'
import { createConnection } from 'net'
import { basename, dirname, join } from 'path'
import { getSessionId } from '../bootstrap/state.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { errorMessage } from './errors.js'
import { isProcessRunning, getProcessPidDomain, getProcessStart, isProcessStartMatching } from './genericProcessUtils.js'
import {
  canonicalPeerEndpoint,
  cleanPeerName,
  formatPeerAddress,
  formatPeerMessage,
  peerKeyFilename,
  peerRef,
  PEER_FEATURE_NOTIFY_IDLE,
  PEER_IDLE_SUBSCRIPTION_CAP,
  PEER_MAX_FRAME_BYTES,
  PEER_TIMEOUT_MS,
  type PeerPermissionClass,
  type PeerMessageStatus,
} from './peerProtocol.js'
import { PEER_IDLE_SUBSCRIPTION_MS, type PeerSent } from './peerNotices.js'

export type LiveSessionInfo = {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  version?: string
  kind?: string
  name: string
  ref: string
  messagingSocketPath: string
  status?: string
  peerProtocol?: number
  peerFeatures?: string[]
}

export async function readPeerFile(path: string, limit: number): Promise<string | undefined> {
  const info = await lstat(path)
  if (!info.isFile() || info.size > limit || (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o022) !== 0))) return
  return readFile(path, 'utf8')
}

export async function validatePeerEndpoint(path: string): Promise<string> {
  const endpoint = canonicalPeerEndpoint(path)
  if (process.platform === 'win32') return endpoint
  const info = await lstat(endpoint)
  if (!info.isSocket() || (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))) {
    throw new Error('Peer endpoint must be a private socket owned by the current user')
  }
  const parent = await lstat(dirname(endpoint))
  if (!parent.isDirectory() || (process.getuid && (parent.uid !== process.getuid() || (parent.mode & 0o022) !== 0))) {
    throw new Error('Peer socket directory must be owned by the current user and not writable by others')
  }
  return endpoint
}

export async function listAllLiveSessions(): Promise<LiveSessionInfo[]> {
  const dir = join(getClaudeConfigHomeDir(), 'sessions')
  let files: string[]
  try { files = await readdir(dir) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logForDebugging(`[peer-discovery] ${errorMessage(error)}`)
    return []
  }
  const peers: LiveSessionInfo[] = []
  for (const file of files) {
    if (!/^[1-9]\d*\.json$/.test(file)) continue
    const pid = Number(file.slice(0, -5))
    if (pid === process.pid || !isProcessRunning(pid)) continue
    try {
      const raw = await readPeerFile(join(dir, file), 65536)
      if (!raw) continue
      const record = JSON.parse(raw)
      if (!record || record.pid !== pid || typeof record.sessionId !== 'string' || typeof record.messagingSocketPath !== 'string' || typeof record.startedAt !== 'number' || record.peerProtocol !== 1 || record.spare || record.parkedJobId) continue
      if (record.pidDomain && record.pidDomain !== await getProcessPidDomain()) continue
      if (typeof record.procStart === 'string') {
        const actual = await getProcessStart(pid)
        if (actual && record.procStart !== actual) continue
      }
      const endpoint = await validatePeerEndpoint(record.messagingSocketPath)
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection(endpoint)
        socket.setTimeout(300, () => socket.destroy(new Error('Peer probe timed out')))
        socket.once('error', reject)
        socket.once('connect', () => { socket.destroy(); resolve() })
      })
      peers.push({
        pid, sessionId: record.sessionId, cwd: typeof record.cwd === 'string' ? record.cwd : '',
        startedAt: record.startedAt, messagingSocketPath: endpoint,
        name: cleanPeerName(typeof record.name === 'string' ? record.name : basename(record.cwd || 'claude')) || `claude-${pid}`,
        ref: peerRef(record.messagingSocketPath),
        ...(typeof record.version === 'string' && { version: record.version }),
        ...(typeof record.kind === 'string' && { kind: record.kind }),
        ...(typeof record.status === 'string' && { status: record.status }),
        peerProtocol: 1,
        peerFeatures: Array.isArray(record.peerFeatures) ? record.peerFeatures.filter((f: unknown): f is string => typeof f === 'string') : [],
      })
    } catch (error) {
      logForDebugging(`[peer-discovery] skipped pid=${pid}: ${errorMessage(error)}`)
    }
  }
  return peers.map(peer => {
    let length = 6
    while (length < 12 && peers.some(other => other !== peer && other.ref.startsWith(peer.ref.slice(0, length)))) length++
    return { ...peer, ref: peer.ref.slice(0, length) }
  }).sort((a, b) => a.name.localeCompare(b.name) || a.pid - b.pid)
}

export async function resolvePeerSession(to: string): Promise<LiveSessionInfo | undefined> {
  const peers = await listAllLiveSessions()
  const match = /^(.*\S)\s*\[([0-9a-f]{6,12})\]$/.exec(to.trim())
  const normalize = (name: string) => name.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '-')
  const candidates = peers.filter(peer => match
    ? normalize(peer.name) === normalize(match[1]!) && peerRef(peer.messagingSocketPath).startsWith(match[2]!)
    : normalize(peer.name) === normalize(to) || peer.sessionId === to)
  if (candidates.length > 1) throw new Error(`Ambiguous peer name. Use ${candidates.map(p => `${p.name} [${p.ref}]`).join(' or ')}`)
  return candidates[0]
}

async function readPeerToken(endpoint: string): Promise<string | undefined> {
  const dir = join(getClaudeConfigHomeDir(), 'sessions')
  let files: string[]
  try { files = await readdir(dir) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && process.platform !== 'win32') return
    throw error
  }
  const suffix = peerKeyFilename(1, endpoint).slice(1)
  const matches = files.filter(file => /^\d+\.[0-9a-f]{64}\.key$/.test(file) && file.endsWith(suffix))
  for (const file of matches) {
    const pid = Number(file.split('.')[0])
    if (!isProcessRunning(pid)) continue
    const raw = await readPeerFile(join(dir, file), 4096)
    if (!raw) continue
    const record = JSON.parse(raw)
    if (record.pidDomain && record.pidDomain !== await getProcessPidDomain()) continue
    if (!await isProcessStartMatching(pid, record)) continue
    if (typeof record.peerToken === 'string' && /^[0-9a-f]{32}$/.test(record.peerToken)) return record.peerToken
  }
  if (matches.length || process.platform === 'win32') throw new Error('No usable authentication key for the live peer endpoint')
}

export async function sendPeerFrame(path: string, frame: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const endpoint = await validatePeerEndpoint(path)
  const token = await readPeerToken(endpoint)
  signal?.throwIfAborted()
  const line = JSON.stringify(frame) + '\n'
  if (Buffer.byteLength(line) > PEER_MAX_FRAME_BYTES) throw new Error('Peer message exceeds 1 MiB')
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(endpoint)
    const abort = () => socket.destroy(new Error('Peer send cancelled; delivery is unknown'))
    signal?.addEventListener('abort', abort, { once: true })
    let written = false
    let endTimer: ReturnType<typeof setTimeout> | undefined
    const timeout = setTimeout(() => socket.destroy(new Error('Peer send timed out; delivery is unknown')), PEER_TIMEOUT_MS)
    socket.once('connect', () => {
      socket.write((token ? JSON.stringify({ type: 'auth', token }) + '\n' : '') + line, () => { written = true })
      // Bun on macOS can close a Unix socket before the peer drains the write.
      if (process.platform === 'darwin') endTimer = setTimeout(() => { if (!socket.destroyed) socket.end() }, 150)
      else socket.end()
    })
    socket.once('error', reject)
    socket.once('close', hadError => {
      clearTimeout(timeout)
      clearTimeout(endTimer)
      signal?.removeEventListener('abort', abort)
      if (!hadError && written) resolve()
      else reject(new Error('Peer connection closed before send completed'))
    })
  })
}

const pending = new Map<string, { endpoint: string; name?: string; time: number; status?: PeerMessageStatus }>()
let onStatus: ((status: PeerMessageStatus, sent: PeerSent) => void) | null = null

export function setOnPeerMessageStatus(callback: typeof onStatus): void { onStatus = callback }

export function receivePeerMessageStatus(id: string, from: string, status: PeerMessageStatus): boolean {
  const sent = pending.get(id)
  if (!sent || formatPeerAddress(sent.endpoint) !== from) return false
  sent.status = status
  logForDebugging(`[peer-status] msg_id=${id} status=${status}`)
  if (status !== 'held') pending.delete(id)
  onStatus?.(status, { endpoint: sent.endpoint, name: sent.name, msgId: id })
  return true
}

type IdleSubscription = { msgId: string; label: string; endpoint: string; sessionId: string; expiry: ReturnType<typeof setTimeout> }
const idleSubscriptions: IdleSubscription[] = []
let onIdleExpired: ((label: string) => void) | null = null

export function setOnPeerIdleExpired(callback: typeof onIdleExpired): void { onIdleExpired = callback }

export type PeerIdleSubscribeResult =
  | { ok: true; peerKnownCapable: boolean }
  | { ok: false; reason: 'requester-refuses-inbound' | 'no-inbox' | 'self-target' | 'peer-unsupported' | 'cap' | 'peer-gone' | 'send-failed' }

/** Ask a local session for one peer_idle_notice when it next goes idle or exits. */
export async function subscribePeerIdle(
  socketPath: string,
  label: string,
  fromMode?: PeerPermissionClass,
): Promise<PeerIdleSubscribeResult> {
  const { getUdsMessagingSocketPath, getPeerInboundSetting } = await import('./udsMessaging.js')
  const ownPath = getUdsMessagingSocketPath()
  if (!ownPath) return { ok: false, reason: 'no-inbox' }
  if (getPeerInboundSetting() === 'refuse') return { ok: false, reason: 'requester-refuses-inbound' }
  const endpoint = canonicalPeerEndpoint(socketPath)
  if (endpoint === canonicalPeerEndpoint(ownPath)) return { ok: false, reason: 'self-target' }
  const record = (await listAllLiveSessions()).find(peer => peer.messagingSocketPath === endpoint)
  if (record && !record.peerFeatures?.includes(PEER_FEATURE_NOTIFY_IDLE)) return { ok: false, reason: 'peer-unsupported' }
  for (let index = idleSubscriptions.length - 1; index >= 0; index--) {
    if (idleSubscriptions[index]!.sessionId !== getSessionId()) clearTimeout(idleSubscriptions.splice(index, 1)[0]!.expiry)
  }
  if (idleSubscriptions.filter(sub => sub.endpoint !== endpoint).length >= PEER_IDLE_SUBSCRIPTION_CAP) return { ok: false, reason: 'cap' }
  const msgId = randomUUID()
  const expiry = setTimeout(() => {
    const index = idleSubscriptions.findIndex(sub => sub.msgId === msgId)
    if (index === -1) return
    const [sub] = idleSubscriptions.splice(index, 1)
    if (sub!.sessionId === getSessionId()) onIdleExpired?.(sub!.label)
  }, PEER_IDLE_SUBSCRIPTION_MS)
  expiry.unref?.()
  idleSubscriptions.push({ msgId, label, endpoint, sessionId: getSessionId(), expiry })
  try {
    await sendPeerFrame(endpoint, {
      msgV: 1, msg_id: msgId, type: 'control', action: 'notify_when_idle',
      from: formatPeerAddress(ownPath), ...(fromMode ? { from_mode: fromMode } : {}),
    })
  } catch (error) {
    clearTimeout(expiry)
    idleSubscriptions.splice(idleSubscriptions.findIndex(sub => sub.msgId === msgId), 1)
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'peer-gone' : 'send-failed' }
  }
  // The receiver keeps one subscription per requester; drop our older ones.
  for (let index = idleSubscriptions.length - 1; index >= 0; index--) {
    const sub = idleSubscriptions[index]!
    if (sub.endpoint === endpoint && sub.msgId !== msgId) clearTimeout(idleSubscriptions.splice(index, 1)[0]!.expiry)
  }
  logForDebugging(`[peer-idle] subscribed msg_id=${msgId}`)
  return { ok: true, peerKnownCapable: record !== undefined }
}

/** Correlates a peer_idle_notice with an outstanding subscription and consumes it. */
export function receivePeerIdleNotice(origMsgId: string, from: string | undefined): { label: string } | undefined {
  const index = idleSubscriptions.findIndex(sub => sub.msgId === origMsgId)
  if (index === -1) return
  const sub = idleSubscriptions[index]!
  if (from !== undefined && formatPeerAddress(sub.endpoint) !== from) return
  idleSubscriptions.splice(index, 1)
  clearTimeout(sub.expiry)
  if (sub.sessionId !== getSessionId()) return
  return { label: sub.label }
}

export function clearPeerIdleSubscriptions(): void {
  for (const sub of idleSubscriptions.splice(0)) clearTimeout(sub.expiry)
}

export async function sendToUdsSocket(
  socketPath: string,
  message: string,
  options: { fromMode?: PeerPermissionClass; fromName?: string; fromPlugin?: string; toName?: string; signal?: AbortSignal } = {},
): Promise<{ msg_id: string }> {
  const { getUdsMessagingSocketPath, getPeerPermissionClass } = await import('./udsMessaging.js')
  const ownPath = getUdsMessagingSocketPath()
  if (!ownPath) throw new Error('Local messaging inbox is not running')
  const endpoint = canonicalPeerEndpoint(socketPath)
  if (endpoint === canonicalPeerEndpoint(ownPath)) throw new Error('Cannot send a peer message to this session')
  const from = formatPeerAddress(ownPath)
  const id = randomUUID()
  const { getRegisteredSessionName } = await import('./concurrentSessions.js')
  const content = formatPeerMessage(message, {
    from,
    fromName: options.fromName ?? getRegisteredSessionName(),
    fromMode: options.fromMode ?? getPeerPermissionClass(),
  })
  for (const [key, sent] of pending) if (Date.now() - sent.time > 600000) pending.delete(key)
  if (pending.size >= 100) pending.delete(pending.keys().next().value!)
  pending.set(id, { endpoint, ...(options.toName ? { name: options.toName } : {}), time: Date.now() })
  try {
    await sendPeerFrame(endpoint, { msgV: 1, msg_id: id, type: 'user', message: { role: 'user', content }, priority: 'next', from, ...(options.fromPlugin ? {from_plugin:options.fromPlugin} : {}) }, options.signal)
    logForDebugging(`[uds-client] Sent msg_id=${id} session=${getSessionId()}`)
    return { msg_id: id }
  } catch (error) {
    pending.delete(id)
    throw error
  }
}
