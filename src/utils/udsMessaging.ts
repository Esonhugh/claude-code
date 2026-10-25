import { randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { chmod, lstat, mkdir, stat, unlink, writeFile } from 'fs/promises'
import { createServer, type Server, type Socket } from 'net'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import stripAnsi from 'strip-ansi'
import { getSessionId, onSessionSwitch } from '../bootstrap/state.js'
import type { PermissionMode } from '../types/permissions.js'
import type { QueuedCommand } from '../types/textInputTypes.js'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { errorMessage } from './errors.js'
import { getProcessPidDomain, getProcessStartMetadata } from './genericProcessUtils.js'
import { dequeueAllMatching, enqueue, getCommandQueue } from './messageQueueManager.js'
import { parseAddress } from './peerAddress.js'
import { enqueueInboundMessage } from './inboundMessageQueue.js'
import {
  canonicalPeerEndpoint, formatPeerAddress, formatPeerMessage, inboundHoldCause, parsePeerMessage,
  peerKeyFilename, PEER_IDLE_SUBSCRIPTION_CAP, PEER_MAX_FRAME_BYTES, PEER_TIMEOUT_MS, PEER_UUID,
  resolveInboundPolicy, type PeerHoldCause, type PeerInboundPolicy, type PeerMessageStatus,
  type PeerPermissionClass,
} from './peerProtocol.js'
import { createReceiptNotices, idleNotice, PEER_IDLE_SUBSCRIPTION_MS, type PeerNotice } from './peerNotices.js'
import { subscribe as subscribeSettings } from './settings/changeDetector.js'
import { getEnabledSettingSources, type SettingSource } from './settings/constants.js'
import { getSettingsForSource } from './settings/settings.js'
import {
  clearPeerIdleSubscriptions, receivePeerIdleNotice, receivePeerMessageStatus, sendPeerFrame,
  setOnPeerIdleExpired, setOnPeerMessageStatus,
} from './udsClient.js'

let socketPath: string | null = null
let server: Server | null = null
let keyPath: string | undefined
let onEnqueue: (() => void) | null = null
let getMode: (() => { mode: PermissionMode; isBypassPermissionsModeAvailable?: boolean }) | undefined
let unregisterCleanup: (() => void) | undefined
let unsubscribeSettings: (() => void) | undefined
let unsubscribeSession: (() => void) | undefined
let expiryTimer: ReturnType<typeof setInterval> | undefined
const clients = new Set<Socket>()
type HeldPeerMessage = { command: QueuedCommand; time: number; cause: PeerHoldCause }
const held: HeldPeerMessage[] = []
export type HeldPeerMessageInfo = { uuid: string; from: string; claimedName?: string; preview: string; cause: PeerHoldCause }
let onHeld: ((message: HeldPeerMessageInfo, heldCount: number) => void) | null = null
let onHeldGone: ((uuid: string) => void) | null = null
export type PeerReleaseReason = 'mode-changed' | 'policy-accepts' | 'approved'
let onReleased: ((count: number, reason: PeerReleaseReason) => void) | null = null
let onNotice: ((text: string) => void) | null = null
let receiptNotices: ReturnType<typeof createReceiptNotices> | undefined
type IdleSubscriber = { target: string; msgId: string; time: number }
const idleSubscribers: IdleSubscriber[] = []
let sessionIdle = false
let idleSince = 0
let idleTimer: ReturnType<typeof setTimeout> | undefined
const seen = new Map<string, number>()
let receipts: Promise<void> = Promise.resolve()
let receiptController = new AbortController()
let inboundController = new AbortController()
let receiptCount = 0
let stopping = false

export function getDefaultUdsSocketPath(): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\cc-msg-${randomBytes(16).toString('hex')}`
  const runtimeDir = process.env.XDG_RUNTIME_DIR || (process.platform === 'darwin' ? '/tmp' : tmpdir())
  const path = join(runtimeDir, 'cc-socks', `${process.pid}.sock`)
  return Buffer.byteLength(path) <= 103 ? path : join('/tmp', `cc-socks-${process.getuid?.() ?? 0}`, `${process.pid}.sock`)
}

export function getUdsMessagingSocketPath(): string | null { return socketPath }
export function setOnEnqueue(callback: (() => void) | null): void { onEnqueue = callback }
export function notifyEnqueued(): void { onEnqueue?.() }

export function setPeerPermissionContext(getter: typeof getMode): void {
  getMode = getter
  refreshPeerInboundPolicy()
}

export function getPeerPermissionClass(): PeerPermissionClass | undefined {
  const context = getMode?.()
  if (!context) return
  return context.mode === 'bypassPermissions' || (context.mode === 'plan' && context.isBypassPermissionsModeAvailable) ? 'bypass' : 'prompting'
}

function inboundSources(): Partial<Record<SettingSource, PeerInboundPolicy>> {
  const sources: Partial<Record<SettingSource, PeerInboundPolicy>> = {}
  for (const source of getEnabledSettingSources()) {
    const policy = getSettingsForSource(source)?.crossSessionInbound
    if (policy !== undefined) sources[source] = policy
  }
  return sources
}

const senderMode = (command: QueuedCommand) => command.origin?.kind === 'peer' ? command.origin.fromMode : undefined

function policyFor(command: QueuedCommand): PeerInboundPolicy {
  return resolveInboundPolicy(inboundSources(), getPeerPermissionClass(), senderMode(command))
}

/** The policy set by crossSessionInbound settings, or undefined when permission modes decide. */
export function getPeerInboundSetting(): PeerInboundPolicy | undefined {
  const sources = inboundSources()
  return Object.keys(sources).length ? resolveInboundPolicy(sources, undefined) : undefined
}

/** This session's inbound policy for peer traffic that asserts no permission mode. */
export function getUnassertedPeerInboundPolicy(): PeerInboundPolicy {
  return resolveInboundPolicy(inboundSources(), getPeerPermissionClass())
}

export function setOnPeerHeld(callback: typeof onHeld): void { onHeld = callback }
export function setOnPeerHeldGone(callback: typeof onHeldGone): void { onHeldGone = callback }
export function setOnPeerHeldReleased(callback: typeof onReleased): void { onReleased = callback }
/** Transcript-only lines for the user (held, released, delivery and idle notices). */
export function setOnPeerNotice(callback: typeof onNotice): void { onNotice = callback }

function deliverNotice(notice: PeerNotice): void {
  onNotice?.(notice.transcript)
  if (!notice.model) return
  enqueue({ mode: 'prompt', value: notice.model, uuid: randomUUID(), priority: 'later', skipSlashCommands: true, skipAttachments: true, isMeta: true })
  notifyEnqueued()
}

function hold(command: QueuedCommand): void {
  if (held.length >= 100) {
    const dropped = held.shift()!
    receipt(dropped.command, 'expired')
    onHeldGone?.(dropped.command.uuid!)
  }
  const cause = inboundHoldCause(inboundSources(), getPeerPermissionClass(), senderMode(command))
  held.push({ command, time: Date.now(), cause })
  receipt(command, 'held')
  logForDebugging(`[uds-messaging] held peer message count=${held.length}`)
  const origin = command.origin?.kind === 'peer' ? command.origin : undefined
  const value = typeof command.value === 'string' ? command.value : ''
  onHeld?.({
    uuid: command.uuid!,
    from: origin?.from ?? 'unknown',
    ...(origin?.name ? { claimedName: origin.name } : {}),
    preview: stripAnsi(parsePeerMessage(value)?.body ?? value).replace(/\r\n?/g, '\n').replace(/[\p{Cc}\p{Cf}]/gu, c => c === '\n' || c === '\t' ? c : ''),
    cause,
  }, held.length)
}

/** Applies the user's decision on a held message; 'gone' when it was already resolved. */
export function resolveHeldPeerMessage(uuid: string, decision: 'approve' | 'deny'): 'delivered' | 'denied' | 'dropped' | 'gone' {
  const index = held.findIndex(item => item.command.uuid === uuid)
  if (index === -1) return 'gone'
  const command = held.splice(index, 1)[0]!.command
  scheduleIdleFlush()
  if (decision === 'deny') {
    receipt(command, 'denied')
    return 'denied'
  }
  if (policyFor(command) === 'refuse') {
    receipt(command, 'refused')
    return 'dropped'
  }
  admit(command, true, true)
  onReleased?.(1, 'approved')
  return 'delivered'
}

// Without Bun.ant peer PID verification, only our own protected namespace is
// eligible for automatic replies. Active named sends may use other dirs.
function replyTarget(from: string): string | undefined {
  if (!socketPath) return
  const address = parseAddress(from)
  if (address.scheme !== 'uds') return
  let target: string
  try { target = canonicalPeerEndpoint(address.target) } catch { return }
  if (process.platform === 'win32'
    ? !/^\\\\\.\\pipe\\(?:local\\)?cc-msg-[0-9a-f]{32}$/i.test(target)
    : dirname(target) !== dirname(socketPath)) return
  if (target === socketPath) return
  return target
}

function senderModeField(): { from_mode?: PeerPermissionClass } {
  const mode = getPeerPermissionClass()
  return mode ? { from_mode: mode } : {}
}

function sendControl(target: string, frame: Record<string, unknown>, label: string): void {
  if (receiptCount >= 200) {
    logForDebugging('[uds-messaging] receipt backlog full')
    return
  }
  const signal = receiptController.signal
  const own = socketPath!
  receiptCount++
  receipts = receipts.then(async () => {
    if (signal.aborted) return
    await sendPeerFrame(target, { msgV: 1, msg_id: randomUUID(), type: 'control', ...frame, from: formatPeerAddress(own) }, signal)
    logForDebugging(`[uds-messaging] ${label}`)
  }).catch(error => {
    if (!signal.aborted) logForDebugging(`[uds-messaging] ${label} failed: ${errorMessage(error)}`)
  }).finally(() => { receiptCount-- })
}

function receipt(command: QueuedCommand, status: PeerMessageStatus): void {
  const origin = command.origin
  if (origin?.kind !== 'peer' || !origin.msg_id) return
  const target = replyTarget(origin.from)
  if (!target) {
    logForDebugging(`[uds-messaging] receipt skipped: no reply target in socket namespace msg_id=${origin.msg_id}`)
    return
  }
  sendControl(target, {
    action: 'peer_message_status',
    ...(status === 'refused' ? { status: 'expired', status_detail: 'refused' } : { status }),
    orig_msg_id: origin.msg_id,
  }, `receipt msg_id=${origin.msg_id} status=${status}`)
}

/** REPL/headless report whether the main conversation is idle (nothing running or queued). */
export function setPeerSessionIdle(idle: boolean): void {
  if (idle === sessionIdle) return
  sessionIdle = idle
  if (idle) {
    idleSince = Date.now()
    scheduleIdleFlush()
  } else {
    clearTimeout(idleTimer)
    idleTimer = undefined
  }
}

function scheduleIdleFlush(delay = 750): void {
  if (!sessionIdle || idleTimer || !idleSubscribers.length) return
  idleTimer = setTimeout(flushIdleSubscribers, delay)
  idleTimer.unref?.()
}

function flushIdleSubscribers(): void {
  idleTimer = undefined
  if (!sessionIdle) return
  for (let index = idleSubscribers.length - 1; index >= 0; index--) {
    if (Date.now() - idleSubscribers[index]!.time > PEER_IDLE_SUBSCRIPTION_MS) idleSubscribers.splice(index, 1)
  }
  // A held message or queued input means this session is not done yet.
  if (held.length) return scheduleIdleFlush(30000)
  if (getCommandQueue().length) return scheduleIdleFlush()
  for (const sub of idleSubscribers.splice(0)) {
    sendControl(sub.target, { action: 'peer_idle_notice', ...senderModeField(), orig_msg_id: sub.msgId, state: 'idle', finished_at: idleSince }, `idle notice orig_msg_id=${sub.msgId}`)
  }
}

function subscribeIdle(data: Record<string, unknown>): void {
  if (typeof data.from !== 'string' || typeof data.msg_id !== 'string' || !PEER_UUID.test(data.msg_id)) return
  const target = replyTarget(data.from)
  if (!target) {
    logForDebugging('[uds-messaging] notify_when_idle dropped: reply address outside socket namespace or self')
    return
  }
  const fromMode = data.from_mode === 'bypass' || data.from_mode === 'prompting' ? data.from_mode : undefined
  if (resolveInboundPolicy(inboundSources(), getPeerPermissionClass(), fromMode) === 'refuse') return
  const existing = idleSubscribers.findIndex(sub => sub.target === target)
  if (existing !== -1) idleSubscribers.splice(existing, 1)
  else if (idleSubscribers.length >= PEER_IDLE_SUBSCRIPTION_CAP) {
    sendControl(target, { action: 'peer_idle_notice', ...senderModeField(), orig_msg_id: data.msg_id, state: 'unavailable' }, 'idle subscription refused: table full')
    return
  }
  idleSubscribers.push({ target, msgId: data.msg_id, time: Date.now() })
  onNotice?.(`A process claiming the address ${formatPeerAddress(target)} asked to be told when this session is next idle — it will get one automated status notice.`)
  logForDebugging(`[uds-messaging] notify_when_idle recorded (${idleSubscribers.length} live)`)
  scheduleIdleFlush()
}

function receiveIdleNotice(data: Record<string, unknown>): void {
  if (typeof data.orig_msg_id !== 'string' || typeof data.state !== 'string') return
  const sub = receivePeerIdleNotice(data.orig_msg_id, typeof data.from === 'string' ? data.from : undefined)
  if (!sub) {
    logForDebugging('[uds-messaging] peer_idle_notice dropped: uncorrelated or already delivered')
    return
  }
  const state = data.state === 'idle' || data.state === 'exited' ? data.state : 'unavailable'
  const fromMode = data.from_mode === 'bypass' || data.from_mode === 'prompting' ? data.from_mode : undefined
  const policy = resolveInboundPolicy(inboundSources(), getPeerPermissionClass(), fromMode)
  if (policy === 'refuse') return
  const finishedAt = typeof data.finished_at === 'number' && Number.isFinite(data.finished_at) ? data.finished_at : undefined
  deliverNotice(idleNotice(state, sub.label, state === 'unavailable' ? undefined : finishedAt, policy === 'accept'))
}

function admit(command: QueuedCommand, wasHeld = false, approved = false): void {
  if (getCommandQueue().filter(c => c.origin?.kind === 'peer').length >= 100) {
    receipt(command, 'dropped')
    logForDebugging('[uds-messaging] peer queue full')
    return
  }
  const signal = inboundController.signal
  let queued = false
  let policyHandled = false
  void enqueueInboundMessage(command, { kind: 'peer', ...(command.origin?.kind === 'peer' && command.origin.plugin ? {plugin:command.origin.plugin} : {}) }, {
    signal,
    enqueue: admitted => {
      // Policy and capacity can change while a receive hook is suspended.
      const policy = policyFor(command)
      if (policy === 'hold' && !approved) {
        hold(admitted)
        policyHandled = true
        return { consumed: 'Peer delivery held by permission policy' }
      }
      if (policy === 'refuse') {
        receipt(command, 'refused')
        policyHandled = true
        return { consumed: 'Peer delivery refused by permission policy' }
      }
      if (getCommandQueue().filter(c => c.origin?.kind === 'peer').length >= 100) {
        receipt(command, 'dropped')
        policyHandled = true
        return { consumed: 'Peer queue full' }
      }
      enqueue(admitted)
      queued = true
      notifyEnqueued()
      if (wasHeld) receipt(command, 'delivered')
      logForDebugging(`[uds-messaging] Routed user message to queue msg_id=${command.origin?.kind === 'peer' ? command.origin.msg_id ?? '(none)' : '(none)'}`)
    },
  }).then(() => {
    if (!queued && !policyHandled) receipt(command, 'dropped')
  }).catch(error => {
    receipt(command, signal.aborted ? 'expired' : 'dropped')
    if (!signal.aborted) logForDebugging(`[uds-messaging] receive failed: ${errorMessage(error)}`)
  })
}

export function getHeldPeerMessageCount(): number { return held.length }

export function refreshPeerInboundPolicy(): void {
  let released = 0
  for (let index = 0; index < held.length;) {
    const item = held[index]!
    const policy = policyFor(item.command)
    const expired = Date.now() - item.time >= 600000
    if (policy === 'hold' && !expired) { index++; continue }
    held.splice(index, 1)
    onHeldGone?.(item.command.uuid!)
    if (expired) receipt(item.command, 'expired')
    else if (policy === 'accept') { admit(item.command, true); released++ }
    else receipt(item.command, 'refused')
  }
  if (released) onReleased?.(released, Object.keys(inboundSources()).length ? 'policy-accepts' : 'mode-changed')
}

function handleSessionSwitch(): void {
  inboundController.abort(new Error('Peer inbox session changed'))
  inboundController = new AbortController()
  for (const item of held.splice(0)) { receipt(item.command, 'expired'); onHeldGone?.(item.command.uuid!) }
  for (const command of dequeueAllMatching(cmd => cmd.origin?.kind === 'peer')) receipt(command, 'expired')
  seen.clear()
  idleSubscribers.length = 0
  clearPeerIdleSubscriptions()
}

function handleFrame(frame: unknown): void {
  if (typeof frame !== 'object' || frame === null) return
  const data = frame as Record<string, unknown>
  if ((data.msgV !== undefined && data.msgV !== 1) || (data.session_id !== undefined && data.session_id !== getSessionId())) return
  if (data.type === 'control') {
    const statuses: PeerMessageStatus[] = ['held', 'denied', 'expired', 'delivered', 'refused', 'dropped']
    if (data.action === 'peer_message_status' && typeof data.orig_msg_id === 'string' && typeof data.from === 'string' && statuses.includes(data.status as PeerMessageStatus)) {
      const status = data.status === 'expired' && data.status_detail === 'refused' ? 'refused' : data.status as PeerMessageStatus
      if (!receivePeerMessageStatus(data.orig_msg_id, data.from, status)) logForDebugging('[peer-status] ignored uncorrelated receipt')
    } else if (data.action === 'notify_when_idle') subscribeIdle(data)
    else if (data.action === 'peer_idle_notice') receiveIdleNotice(data)
    return
  }
  if (data.type !== 'user' || typeof data.message !== 'object' || !data.message) return
  const message = data.message as Record<string, unknown>
  if (message.role !== 'user' || typeof message.content !== 'string' || !message.content) return
  const content = message.content
  const metadata = parsePeerMessage(content)
  const from = typeof data.from === 'string' ? data.from : 'unknown'
  const id = typeof data.msg_id === 'string' && PEER_UUID.test(data.msg_id) ? data.msg_id : undefined
  const duplicateKey = id ? `${from}\0${id}` : undefined
  for (const [key, time] of seen) if (Date.now() - time > 600000) seen.delete(key)
  if (duplicateKey && seen.has(duplicateKey)) return
  if (duplicateKey) {
    if (seen.size >= 1000) seen.delete(seen.keys().next().value!)
    seen.set(duplicateKey, Date.now())
  }
  const provenance = metadata?.from === from ? metadata : undefined
  const plugin = typeof data.from_plugin === 'string' ? data.from_plugin.replace(/["<>\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, '').trim() || undefined : undefined
  // Raw legacy frames remain text, but are always explicitly attributed to a
  // peer rather than promoted to a keyboard/user instruction.
  const value = formatPeerMessage(provenance?.body ?? content, {
    ...(from !== 'unknown' && /^[A-Za-z0-9%:_/.\\-]+$/.test(from) && { from }),
    fromName: provenance?.fromName, fromMode: provenance?.fromMode, fromPlugin: plugin,
    fromSession: provenance?.fromSession, hopChain: provenance?.hopChain,
  })
  const command: QueuedCommand = {
    mode: 'prompt',
    value,
    uuid: randomUUID(),
    priority: data.priority === 'now' || data.priority === 'later' ? data.priority : 'next',
    origin: { kind: 'peer', from, msg_id: id, name: provenance?.fromName, fromMode: provenance?.fromMode, ...(plugin ? {plugin} : {}) },
    skipSlashCommands: true, skipAttachments: true, isMeta: true,
  }
  switch (policyFor(command)) {
    case 'accept': admit(command); break
    case 'refuse': receipt(command, 'refused'); break
    case 'hold': hold(command); break
  }
}

export async function startUdsMessaging(
  path: string,
  options: { isExplicit?: boolean; permissionMode?: PermissionMode; isBypassPermissionsModeAvailable?: boolean } = {},
): Promise<void> {
  if (server) throw new Error('Messaging inbox is already running')
  receiptController = new AbortController()
  inboundController = new AbortController()
  stopping = false
  if (options.permissionMode) getMode = () => ({ mode: options.permissionMode!, isBypassPermissionsModeAvailable: options.isBypassPermissionsModeAvailable })
  const endpoint = canonicalPeerEndpoint(path)
  if (process.platform !== 'win32') {
    await mkdir(dirname(endpoint), { recursive: true, mode: 0o700 })
    const dir = await lstat(dirname(endpoint))
    if (!dir.isDirectory() || (process.getuid && (dir.uid !== process.getuid() || (dir.mode & 0o022) !== 0))) throw new Error('Messaging socket directory is not private to this user')
    try { await lstat(endpoint); throw new Error('Messaging endpoint already exists; choose a different socket path') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const peerToken = randomBytes(16).toString('hex')
  const childToken = randomBytes(16).toString('hex')
  const matchesToken = (token: unknown) => typeof token === 'string' && /^[0-9a-f]{32}$/.test(token) &&
    [peerToken, childToken].some(expected => timingSafeEqual(Buffer.from(token), Buffer.from(expected)))
  const inbox = createServer(socket => {
    if (stopping || clients.size >= 32) { socket.destroy(); return }
    clients.add(socket)
    socket.setEncoding('utf8')
    socket.setTimeout(PEER_TIMEOUT_MS, () => socket.destroy())
    let buffer = ''
    let first = true
    socket.on('error', error => logForDebugging(`[uds-messaging] connection error: ${errorMessage(error)}`))
    socket.on('close', () => clients.delete(socket))
    socket.on('data', chunk => {
      buffer += chunk
      let end: number
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (Buffer.byteLength(line) > PEER_MAX_FRAME_BYTES) { socket.destroy(); return }
        let frame: unknown
        try { frame = JSON.parse(line) } catch { logForDebugging('[uds-messaging] ignored malformed JSON'); continue }
        const auth = typeof frame === 'object' && frame !== null && 'type' in frame && frame.type === 'auth'
        if (first) {
          first = false
          if (auth) {
            if (!matchesToken((frame as { token?: unknown }).token)) { socket.destroy(); return }
            continue
          }
          if (process.platform === 'win32') { socket.destroy(); return }
        } else if (auth) { socket.destroy(); return }
        handleFrame(frame)
      }
      if (Buffer.byteLength(buffer) > PEER_MAX_FRAME_BYTES) socket.destroy()
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      inbox.once('error', reject)
      inbox.listen(endpoint, () => { inbox.removeListener('error', reject); resolve() })
    })
    server = inbox
    socketPath = endpoint
    inbox.on('error', error => logForDebugging(`[uds-messaging] server error: ${errorMessage(error)}`))
    if (process.platform !== 'win32') await chmod(endpoint, 0o600)
    const dir = join(getClaudeConfigHomeDir(), 'sessions')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const dirStat = await stat(dir)
    if (!dirStat.isDirectory() || (process.getuid && (dirStat.uid !== process.getuid() || (dirStat.mode & 0o077) !== 0))) throw new Error('Messaging key directory must be private to this user')
    const newKeyPath = join(dir, peerKeyFilename(process.pid, endpoint))
    await writeFile(newKeyPath, JSON.stringify({ peerToken, ...await getProcessStartMetadata(process.pid), pidDomain: await getProcessPidDomain() }), { mode: 0o600, flag: 'wx' })
    keyPath = newKeyPath
    process.env.CLAUDE_CODE_MESSAGING_SOCKET = endpoint
    process.env.CLAUDE_CODE_MESSAGING_TOKEN = childToken
    receiptNotices = createReceiptNotices(deliverNotice)
    setOnPeerMessageStatus((status, sent) => receiptNotices?.note(status, sent))
    setOnPeerIdleExpired(label => {
      if (resolveInboundPolicy(inboundSources(), getPeerPermissionClass()) !== 'refuse') deliverNotice(idleNotice('expired', label))
    })
    unregisterCleanup = registerCleanup(stopUdsMessaging)
    unsubscribeSettings = subscribeSettings(refreshPeerInboundPolicy)
    unsubscribeSession = onSessionSwitch(handleSessionSwitch)
    expiryTimer = setInterval(refreshPeerInboundPolicy, 30000)
    expiryTimer.unref()
    inbox.unref()
    logForDebugging(`[uds-messaging] Listening: ${endpoint}`)
  } catch (error) {
    if (server === inbox) await stopUdsMessaging()
    else inbox.close()
    throw error
  }
}

export async function stopUdsMessaging(): Promise<void> {
  if (!server) return
  stopping = true
  inboundController.abort(new Error('Peer inbox closed'))
  for (const item of held.splice(0)) { receipt(item.command, 'expired'); onHeldGone?.(item.command.uuid!) }
  for (const command of dequeueAllMatching(cmd => cmd.origin?.kind === 'peer')) receipt(command, 'expired')
  for (const sub of idleSubscribers.splice(0)) {
    const state = sessionIdle && !getCommandQueue().length ? 'idle' : 'exited'
    sendControl(sub.target, { action: 'peer_idle_notice', ...senderModeField(), orig_msg_id: sub.msgId, state, finished_at: state === 'idle' ? idleSince : Date.now() }, `${state} notice orig_msg_id=${sub.msgId}`)
  }
  clearTimeout(idleTimer); idleTimer = undefined
  receiptNotices?.dispose(); receiptNotices = undefined
  setOnPeerMessageStatus(null)
  setOnPeerIdleExpired(null)
  clearPeerIdleSubscriptions()
  unsubscribeSettings?.(); unsubscribeSettings = undefined
  unsubscribeSession?.(); unsubscribeSession = undefined
  unregisterCleanup?.(); unregisterCleanup = undefined
  clearInterval(expiryTimer); expiryTimer = undefined
  for (const client of clients) client.destroy()
  clients.clear()
  const inbox = server
  await new Promise<void>(resolve => inbox.close(() => resolve()))
  let timeout: ReturnType<typeof setTimeout> | undefined
  await Promise.race([receipts, new Promise<void>(resolve => { timeout = setTimeout(resolve, 750) })])
  clearTimeout(timeout)
  receiptController.abort()
  await receipts
  const endpoint = socketPath
  socketPath = null
  if (keyPath) await unlink(keyPath).catch(error => { if (error.code !== 'ENOENT') logForDebugging(`[uds-messaging] key cleanup: ${errorMessage(error)}`) })
  keyPath = undefined
  if (endpoint && process.platform !== 'win32') await unlink(endpoint).catch(error => { if (error.code !== 'ENOENT') logForDebugging(`[uds-messaging] socket cleanup: ${errorMessage(error)}`) })
  if (process.env.CLAUDE_CODE_MESSAGING_SOCKET === endpoint) {
    delete process.env.CLAUDE_CODE_MESSAGING_SOCKET
    delete process.env.CLAUDE_CODE_MESSAGING_TOKEN
  }
  seen.clear()
  getMode = undefined
  server = null
}
