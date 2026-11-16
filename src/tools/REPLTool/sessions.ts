import { getSessionId } from '../../bootstrap/state.js'
import type { Message } from '../../types/message.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { formatDuration } from '../../utils/format.js'
import {
  enqueuePendingNotification,
  getCommandQueueSnapshot,
  removeByFilter,
} from '../../utils/messageQueueManager.js'
import { createReplExecutor, type ReplExecutor } from './executor/host.js'

/** A script the async lane dispatched that has not ended yet. */
export type ReplPendingEval = {
  id: number
  startedAt: number
  abort(reason?: unknown): void
}

/** Official ledger states (2.1.325 chunk-gcw6cvys.js `ledger()`). */
export type ReplEvalState = 'waiting' | 'running' | 'detached' | 'late'

/** An async-lane eval from its dispatch until it finished (official registry entry). */
export type ReplLedgerEval = {
  /** Unset while it waits for the scripts before it. */
  startedAt: number | undefined
  /** The executor let the next script start beside it. */
  detached: boolean
  /** It settled with calls still running (official `holdLate`). */
  late: boolean
  snippet: string
  /** The calls it made that have not started yet, for the status line. */
  readNotYetStarted?: () => string[]
}

export type ReplLedgerRow = {
  id: number
  state: ReplEvalState
  runningMs: number
  snippet: string
  notYetStarted: string[]
}

const SNIPPET_CHARS = 100

/** A dispatched script's outcome, queued as a notification until a Poll call or the next turn takes it. */
export type ReplEvalEvent = {
  id: number
  text: string
  /** Whether the notification queue took it; one it didn't (a Mods hook dropped it) only Poll delivers. */
  queued?: boolean
}

/** One persistent JavaScript context per conversation thread: the main thread or a subagent. */
export type ReplSession = {
  executor: ReplExecutor
  /** The session id the context was made in; a new one (/clear, a resume, a fork) starts over. */
  epoch: string
  /** False until the first script ran, so the first call knows it is in a new context. */
  used: boolean
  /** Eval numbers, as in `(dispatched #N)` and `<repl-output eval="N">`. */
  nextEvalId: number
  pending: Map<number, ReplPendingEval>
  /** Outcomes of dispatched scripts not yet taken by Poll. */
  events: ReplEvalEvent[]
  /** Virtual messages from dispatched scripts (inner calls, failure pairs) for the next REPL or Poll result. */
  lateMessages: Message[]
  /** Poll calls waiting for the next event. */
  waiters: Set<() => void>
  /** Async-lane evals from dispatch until they finished; a late one stays until its calls end. */
  ledger: Map<number, ReplLedgerEval>
  /** Evals dispatched and not finished yet (official `depth`), what the dispatch cap counts. */
  depth: number
  /** Evals no wait after tool calls or Poll has waited on yet. */
  unwaited: Set<number>
  /** Evals whose outcome has not been delivered yet. */
  undelivered: Set<number>
  /** A status line for the pending evals was given since the last dispatch. */
  statusLineGiven: boolean
  ledgerListeners: Set<() => void>
  /** Which agent's queue the notifications go to (undefined: the main thread). */
  agentId: string | undefined
  released: boolean
}

export const MAIN_REPL_SESSION = 'main'

const sessions = new Map<string, ReplSession>()
let unregisterCleanup: (() => void) | undefined

/** The context for `key`, made on first use or when the session id moved on. */
export function getReplSession(key: string): ReplSession {
  const epoch = getSessionId()
  const existing = sessions.get(key)
  if (existing && existing.epoch === epoch) return existing
  existing?.executor.release()
  const session: ReplSession = {
    executor: createReplExecutor(),
    epoch,
    used: false,
    nextEvalId: 1,
    pending: new Map(),
    events: [],
    lateMessages: [],
    waiters: new Set(),
    ledger: new Map(),
    depth: 0,
    unwaited: new Set(),
    undelivered: new Set(),
    statusLineGiven: false,
    ledgerListeners: new Set(),
    agentId: key === MAIN_REPL_SESSION ? undefined : key,
    released: false,
  }
  sessions.set(key, session)
  unregisterCleanup ??= registerCleanup(async () => releaseAllReplSessions())
  return session
}

/** Ends the context for `key` (a finished subagent); the next script there starts fresh. */
export function releaseReplSession(key: string): void {
  const session = sessions.get(key)
  if (!session) return
  sessions.delete(key)
  session.released = true
  session.executor.release()
  wake(session)
}

/** The context for `key` if one exists in this session id, without making one. */
export function findReplSession(key: string): ReplSession | undefined {
  const session = sessions.get(key)
  return session && session.epoch === getSessionId() ? session : undefined
}

function wake(session: ReplSession): void {
  for (const waiter of [...session.waiters]) waiter()
  session.waiters.clear()
}

/**
 * Hands a dispatched script's outcome to the model: queued as a notification
 * (so it reaches the next turn when nobody polls) and kept for Poll, which
 * takes it out of the queue instead.
 */
export async function deliverReplEvent(session: ReplSession, event: ReplEvalEvent, messages: Message[]): Promise<void> {
  if (session.released) return
  session.lateMessages.push(...messages)
  try {
    await enqueuePendingNotification({ value: event.text, mode: 'task-notification', agentId: session.agentId as never })
  } finally {
    // Listed once the queue has it (or refused it), so Poll never misses it in between.
    event.queued = getCommandQueueSnapshot().some(cmd => cmd.mode === 'task-notification' && cmd.value === event.text)
    session.pending.delete(event.id)
    markReplEvalDelivered(session, event.id)
    if (!session.released) session.events.push(event)
    wake(session)
  }
}

function ledgerChanged(session: ReplSession): void {
  for (const listener of [...session.ledgerListeners]) listener()
}

/** Official `dispatch`: the eval is waiting for its turn, unwaited and undelivered until its outcome goes out. */
export function dispatchReplEval(session: ReplSession, id: number, code: string): ReplLedgerEval {
  const entry: ReplLedgerEval = {
    startedAt: undefined,
    detached: false,
    late: false,
    snippet: code.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS),
  }
  session.ledger.set(id, entry)
  session.depth++
  session.unwaited.add(id)
  session.undelivered.add(id)
  session.statusLineGiven = false
  ledgerChanged(session)
  return entry
}

export function startReplEval(session: ReplSession, id: number): void {
  const entry = session.ledger.get(id)
  if (!entry) return
  entry.startedAt = Date.now()
  ledgerChanged(session)
}

export function detachReplEval(session: ReplSession, id: number): void {
  const entry = session.ledger.get(id)
  if (!entry) return
  entry.detached = true
  ledgerChanged(session)
}

/** The script ended; one holding late calls stays in the ledger until endLateReplEval. */
export function finishReplEval(session: ReplSession, id: number, { late = false } = {}): void {
  const entry = session.ledger.get(id)
  if (!entry) return
  session.depth--
  if (late) entry.late = true
  else session.ledger.delete(id)
  ledgerChanged(session)
}

export function endLateReplEval(session: ReplSession, id: number): void {
  if (session.ledger.get(id)?.late !== true) return
  session.ledger.delete(id)
  ledgerChanged(session)
}

/** Official `T`: the outcome went out, so nothing waits on it any more. */
export function markReplEvalDelivered(session: ReplSession, id: number): void {
  session.unwaited.delete(id)
  session.undelivered.delete(id)
  ledgerChanged(session)
}

/** Official `ledger()`, in dispatch order. */
export function replLedger(session: ReplSession, now = Date.now()): ReplLedgerRow[] {
  return [...session.ledger].map(([id, entry]) => ({
    id,
    state: entry.late ? 'late' : entry.startedAt === undefined ? 'waiting' : entry.detached ? 'detached' : 'running',
    runningMs: entry.startedAt === undefined ? 0 : now - entry.startedAt,
    snippet: entry.snippet,
    notYetStarted: entry.readNotYetStarted?.() ?? [],
  }))
}

/** Official `takeUnwaited`: the unwaited evals (those in `ids` when given), no longer unwaited. */
export function takeUnwaitedReplEvals(session: ReplSession, ids?: ReadonlySet<number>): number[] {
  const taken = [...session.unwaited].filter(id => ids?.has(id) ?? true)
  for (const id of taken) session.unwaited.delete(id)
  return taken
}

export function noteReplStatusLine(session: ReplSession): void {
  session.statusLineGiven = true
}

/** Official `takeStatusLineGiven`: whether a status line was given, and clears it. */
export function takeReplStatusLineGiven(session: ReplSession): boolean {
  const given = session.statusLineGiven
  session.statusLineGiven = false
  return given
}

/** Official `onRunningScriptsChange`: called on every ledger change; returns the unsubscribe. */
export function onReplLedgerChange(session: ReplSession, listener: () => void): () => void {
  session.ledgerListeners.add(listener)
  return () => void session.ledgerListeners.delete(listener)
}

/** Official H6t and SBe: one Poll delivery holds at most this many events and bytes (always at least one event). */
export const POLL_CHUNK_EVENTS = 20
export const POLL_CHUNK_BYTES = 32_768

/**
 * Official `drainPollEventChunk`: the oldest events the next turn has not
 * taken yet that fit one delivery, out of the notification queue so they
 * arrive once; the rest stay queued for the next delivery.
 */
export function takeReplEventChunk(
  session: ReplSession,
  maxEvents = POLL_CHUNK_EVENTS,
  maxBytes = POLL_CHUNK_BYTES,
): { events: ReplEvalEvent[]; remaining: number } {
  // An event no longer queued (and not one the queue refused) was delivered with a turn.
  const live = session.events.filter(
    event => event.queued === false || getCommandQueueSnapshot().some(cmd => cmd.mode === 'task-notification' && cmd.value === event.text),
  )
  const events: ReplEvalEvent[] = []
  let bytes = 0
  for (const event of live) {
    const size = Buffer.byteLength(event.text, 'utf8')
    if (events.length > 0 && (events.length + 1 > maxEvents || bytes + size > maxBytes)) break
    events.push(event)
    bytes += size
  }
  for (const event of events) removeByFilter(cmd => cmd.mode === 'task-notification' && cmd.value === event.text)
  session.events = live.slice(events.length)
  return { events, remaining: session.events.length }
}

export function takeReplLateMessages(session: ReplSession): Message[] {
  const messages = session.lateMessages
  session.lateMessages = []
  return messages
}

/** Resolves on the next event, a release, `ms` passing or `signal` aborting. */
export function waitForReplEvent(session: ReplSession, ms: number, signal: AbortSignal): Promise<void> {
  if (session.events.length > 0 || session.released || signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      session.waiters.delete(done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    session.waiters.add(done)
  })
}

/** Stops every dispatched script of the session (Esc, an interrupt). */
export function abortPendingReplEvals(session: ReplSession, reason?: unknown): void {
  for (const pending of [...session.pending.values()]) pending.abort(reason)
}

export function releaseAllReplSessions(): void {
  for (const key of [...sessions.keys()]) releaseReplSession(key)
}

export function hasReplSession(key: string): boolean {
  return sessions.has(key)
}

/** Official `OBr`: attribute values lose the characters that would break the tag. */
function attribute(value: string): string {
  return value.replace(/[&<>"'=\r\n\t]/g, ' ')
}

/** Official `HIe`: event content text, escaped, with control characters dropped. */
function escapeContent(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u0085\u2028\u2029]/g, '')
}

/**
 * A dispatched script's outcome as the official XML event (`hoe`, built in
 * `tr` in 2.1.325): a settled script's `<repl-output>` children, each on its
 * own line; a host-side failure as `eval #N FAILED before settling:` and its text.
 */
export function formatReplEvalEvent(
  id: number,
  ms: number,
  output: string,
  at = new Date(),
  status: 'settled' | 'failed' = 'settled',
): string {
  const open = `<event kind="repl-eval" at="${attribute(at.toISOString())}" eval="${id}" ms="${Math.round(ms)}" status="${status}">`
  if (status === 'failed') return `${open}${escapeContent(`eval #${id} FAILED before settling:\n${output}`)}</event>`
  const body = output.replace(/^<repl-output[^>]*>\n?/, '').replace(/\n?<\/repl-output>$/, '')
  return `${open}\n${body}\n</event>`
}

/** Official lost event (`p` in 2.1.325 chunk-z3r3ymwt.js, status `Jot`): an eval whose outcome will never come. */
export function formatReplLostEvent(id: number, text: string, at = new Date()): string {
  return `<event kind="repl-eval" at="${attribute(at.toISOString())}" eval="${id}" status="lost">${escapeContent(text)}</event>`
}

/**
 * Official `enqueueReplStatus` text (`h(r, false)`, 2.1.325 chunk-2p8jywjd.js).
 * An entry exists only once its call returned the receipt, which is when the
 * official ledger marks it detached; calls waiting at a permission prompt and
 * late output are not tracked here, so those clauses never apply.
 */
export function formatReplStatus(session: ReplSession, at = new Date()): string {
  const now = Date.now()
  const pending = [...session.pending.values()].sort((a, b) => a.id - b.id)
  const parts = pending.map(p => `#${p.id} running for ${formatDuration(now - p.startedAt)} (detached: later evals run beside it)`)
  const text = `no output yet \u2014 ${pending.length} ${pending.length === 1 ? 'eval' : 'evals'} pending: ${parts.join('; ')}. Poll again to keep waiting.`
  return `<event kind="repl-status" at="${attribute(at.toISOString())}" pending="${pending.length}">${escapeContent(text)}</event>`
}
