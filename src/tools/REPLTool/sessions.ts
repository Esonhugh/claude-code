import { getSessionId } from '../../bootstrap/state.js'
import type { Message } from '../../types/message.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { formatDuration } from '../../utils/format.js'
import { truncateToWidth } from '../../utils/truncate.js'
import { enqueuePollEvent, REPL_EVAL_EVENT_KIND, REPL_STATUS_EVENT_KIND } from '../../utils/messageQueueManager.js'
import { SCRIPT_ASK_DECLINED } from './constants.js'
import { createReplExecutor, type ReplExecutor } from './executor/host.js'
import { replScriptLabel } from './scriptLabel.js'
import { isUserStop } from './stopReport.js'

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
  /** The REPL call's `description`, what the spinner shows while it runs. */
  description: string | undefined
  /** The calls it made that have not started yet, for the status line. */
  readNotYetStarted?: () => ReplNotYetStartedCall[]
}

/** A call a script made that has not started, most likely held at a permission prompt. */
export type ReplNotYetStartedCall = { toolName: string; waitingMs: number }

export type ReplLedgerRow = {
  id: number
  state: ReplEvalState
  runningMs: number
  snippet: string
  notYetStarted: ReplNotYetStartedCall[]
}

const SNIPPET_CHARS = 100

/** A dispatched script's outcome, queued as a poll event until a delivery takes it. */
export type ReplEvalEvent = {
  id: number
  text: string
  /** False: the main thread's eval the user stopped, whose outcome waits for the next turn instead of starting one. */
  startsTurn?: false
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
  /** Which agent's queue the events go to (undefined: the main thread). */
  agentId: string | undefined
  released: boolean
}

export const MAIN_REPL_SESSION = 'main'

const sessions = new Map<string, ReplSession>()
let unregisterCleanup: (() => void) | undefined
/** Listeners to the main thread's ledger, across the sessions a new session id makes. */
const mainScriptsListeners = new Set<() => void>()

function mainScriptsChanged(): void {
  for (const listener of [...mainScriptsListeners]) listener()
}

/** The context for `key`, made on first use or when the session id moved on. */
export function getReplSession(key: string): ReplSession {
  const epoch = getSessionId()
  const existing = sessions.get(key)
  if (existing && existing.epoch === epoch) return existing
  existing?.executor.release()
  const session: ReplSession = {
    executor: createReplExecutor({ onAbortEval: id => abortReplEval(session, id) }),
    epoch,
    used: false,
    nextEvalId: 1,
    pending: new Map(),
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
  if (existing && session.agentId === undefined) mainScriptsChanged()
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
  if (session.agentId === undefined) mainScriptsChanged()
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
 * Official `tr`: the outcome goes out as a `repl-eval` poll event, for the
 * wait after tool calls, a turn's first request or Poll to deliver. It
 * counts as delivered once queued.
 */
export function deliverReplEvent(session: ReplSession, event: ReplEvalEvent, messages: Message[]): void {
  if (session.released) return
  session.lateMessages.push(...messages)
  const refused = (error: unknown) =>
    logForDebugging(`async REPL eval #${event.id} outcome not delivered: ${error instanceof Error ? error.message : 'non-Error rejection'}`)
  try {
    enqueuePollEvent({
      kind: REPL_EVAL_EVENT_KIND,
      element: event.text,
      ...(event.startsTurn === false && { startsTurn: false }),
      agentId: session.agentId as never,
    }).catch(() => {})
  } catch (error) {
    refused(error)
  } finally {
    session.pending.delete(event.id)
    markReplEvalDelivered(session, event.id)
    wake(session)
  }
}

/** Official `outstanding`: outcomes still to come, those of late evals' calls included. */
export function outstandingReplEvals(session: ReplSession): number {
  return session.undelivered.size + [...session.ledger.values()].filter(entry => entry.late).length
}

/**
 * Official registry texts for an eval stopped while it waited for the scripts
 * before it. `turnAborted`: the turn that dispatched it was aborted (not a
 * "turn-abort", which keeps it), checked before the reason.
 */
export function replCancelledBeforeStartText(reason: unknown, turnAborted = false): string {
  if (turnAborted)
    return 'cancelled before start \u2014 the dispatching turn was aborted while this eval waited for its turn; the script never ran'
  if (reason === 'interrupt')
    return 'cancelled before start \u2014 the session was interrupted while this eval waited for its turn; the script never ran'
  if (isUserStop(reason))
    return 'cancelled before start \u2014 the user stopped this eval while it waited for its turn; the script never ran'
  if (reason === SCRIPT_ASK_DECLINED)
    return "cancelled before start \u2014 the user declined the permission dialog for an earlier script's call (a No or an Esc), which also cancels the scripts behind that one; the script never ran"
  if (reason === 'task-stop')
    return 'cancelled before start \u2014 a TaskStop call stopped this eval while it waited for its turn; the script never ran'
  if (reason === 'script')
    return 'cancelled before start \u2014 a script aborted this eval (self.running().abort()) while it waited for its turn; it never ran'
  return 'cancelled before start \u2014 Claude Code stopped this eval while it waited for its turn; the script never ran'
}

function ledgerChanged(session: ReplSession): void {
  session.executor.publishRunning(
    [...session.ledger].map(([id, entry]) => ({
      id,
      snippet: entry.snippet,
      startedAt: entry.startedAt ?? null,
      state: ledgerState(entry),
      settled: entry.late,
    })),
  )
  for (const listener of [...session.ledgerListeners]) listener()
  if (session.agentId === undefined && sessions.get(MAIN_REPL_SESSION) === session) mainScriptsChanged()
}

function ledgerState(entry: ReplLedgerEval): ReplEvalState {
  return entry.late ? 'late' : entry.startedAt === undefined ? 'waiting' : entry.detached ? 'detached' : 'running'
}

/**
 * Official registry `abort(id)`, what a script's `running()[i].abort()` calls:
 * an eval still waiting for its turn is cancelled for 'script', a running one
 * is stopped as the user would stop it.
 */
export function abortReplEval(session: ReplSession, id: number): void {
  const pending = session.pending.get(id)
  if (!pending) return
  pending.abort(session.ledger.get(id)?.startedAt === undefined ? 'script' : 'user-cancel')
}

/** Official `dispatch`: the eval is waiting for its turn, unwaited and undelivered until its outcome goes out. */
export function dispatchReplEval(session: ReplSession, id: number, code: string, description?: string): ReplLedgerEval {
  const entry: ReplLedgerEval = {
    startedAt: undefined,
    detached: false,
    late: false,
    snippet: code.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS),
    description,
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
    state: ledgerState(entry),
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

/** Official `onRunningScriptsChange` for the main thread, whichever session id its scripts run under. */
export function onMainReplScriptsChange(listener: () => void): () => void {
  mainScriptsListeners.add(listener)
  return () => void mainScriptsListeners.delete(listener)
}

/** Official `MAX_DESCRIPTION_WIDTH` (2.1.325 chunk-h2wk9qp9.js `sOn`), in columns. */
export const REPL_SCRIPT_DESCRIPTION_WIDTH = 48

/** Official phase order: running, then waiting for its turn, then late. */
function scriptPhase(entry: ReplLedgerEval): number {
  return entry.late ? 2 : entry.startedAt === undefined ? 1 : 0
}

/**
 * Official `describeRunningScripts` (2.1.325 chunk-h2wk9qp9.js `ros`): the
 * description of the first script in the earliest phase, cut to 48 columns,
 * with `+N more` for the other described scripts. Null when that script has
 * no description to show.
 */
export function describeRunningReplScripts(session: ReplSession | undefined): string | null {
  if (!session) return null
  const entries = [...session.ledger].sort(([a, x], [b, y]) => scriptPhase(x) - scriptPhase(y) || a - b)
  const lowest = entries[0] === undefined ? 0 : scriptPhase(entries[0][1])
  const described = entries
    .map(([, entry]) => ({ phase: scriptPhase(entry), text: replScriptLabel(entry.description) }))
    .filter(({ text }) => text !== '')
  const first = described[0]
  if (first === undefined || first.phase !== lowest) return null
  const text = truncateToWidth(first.text, REPL_SCRIPT_DESCRIPTION_WIDTH)
  return described.length === 1 ? text : `${text} +${described.length - 1} more`
}

/** Official `isScriptRunning` (`oos`): a script has started and not ended. */
export function isReplScriptRunning(session: ReplSession | undefined): boolean {
  return !!session && [...session.ledger.values()].some(entry => scriptPhase(entry) === 0)
}

/** The spinner's view of the main thread's scripts, as useSyncExternalStore snapshots. */
export function describeMainReplScripts(): string | null {
  return describeRunningReplScripts(findReplSession(MAIN_REPL_SESSION))
}

export function isMainReplScriptRunning(): boolean {
  return isReplScriptRunning(findReplSession(MAIN_REPL_SESSION))
}

export function takeReplLateMessages(session: ReplSession): Message[] {
  const messages = session.lateMessages
  session.lateMessages = []
  return messages
}

/** Stops every dispatched script of the session (Esc between turns). */
export function abortPendingReplEvals(session: ReplSession, reason?: unknown): void {
  for (const pending of [...session.pending.values()]) pending.abort(reason)
}

/**
 * Official `interrupt` (2.1.325 chunk-gcw6cvys.js), what Esc during a turn
 * calls: a running script is stopped as the user would stop it, one still
 * waiting for its turn is cancelled as interrupted, and the next wait gives
 * a status line again.
 */
export function interruptReplSession(session: ReplSession): void {
  session.statusLineGiven = false
  for (const pending of [...session.pending.values()])
    pending.abort(session.ledger.get(pending.id)?.startedAt === undefined ? 'interrupt' : 'user-cancel')
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

/** Official late event (`gc` with `bi`): what a settled eval logged since, under the line that says so. */
export function formatReplLateEvent(id: number, log: string, at = new Date()): string {
  const logs = [`[late output from eval #${id} (settled earlier) \u2014 delivered below.]`, log]
  return `<event kind="repl-eval" at="${attribute(at.toISOString())}" eval="${id}" status="late">\n${logs.map(text => `<log>${escapeContent(text)}</log>`).join('\n')}\n</event>`
}

/** Official lost event (`p` in 2.1.325 chunk-z3r3ymwt.js, status `Jot`): an eval whose outcome will never come. */
export function formatReplLostEvent(id: number, text: string, at = new Date()): string {
  return `<event kind="repl-eval" at="${attribute(at.toISOString())}" eval="${id}" status="lost">${escapeContent(text)}</event>`
}

/** Official `c` and `v` in 2.1.325 chunk-2p8jywjd.js: evals and calls the not-started clause names. */
const STATUS_NOT_STARTED_EVALS = 3
const STATUS_NOT_STARTED_CALLS = 5

/** Official `f`: the clause for an eval's calls that have not started. */
function notStartedClause(calls: readonly ReplNotYetStartedCall[]): string {
  const pronoun = calls.length === 1 ? 'it' : 'they'
  const named = calls.slice(0, STATUS_NOT_STARTED_CALLS).map(call => `${call.toolName} after ${formatDuration(call.waitingMs)}`)
  const more = calls.length - named.length
  const list = more > 0 ? `${named.join(', ')} and ${more} more` : named.join(', ')
  return calls.length === 1
    ? `its ${calls[0]!.toolName} call hasn't started after ${formatDuration(calls[0]!.waitingMs)} (${pronoun} may be waiting for the user to answer a permission prompt)`
    : `${calls.length} of its calls haven't started: ${list} (${pronoun} may be waiting for the user to answer a permission prompt)`
}

/**
 * Official status line text (`h(n, r)` in 2.1.325 chunk-2p8jywjd.js) for the
 * pending evals; `stillPending` is the form the wait after tool calls gives
 * when some outcomes went out and others did not.
 */
export function replStatusText(rows: readonly ReplLedgerRow[], stillPending = false): string {
  const blocked = rows.filter(row => row.notYetStarted.length > 0)
  const named = new Set(blocked.slice(0, STATUS_NOT_STARTED_EVALS).map(row => row.id))
  const unnamed = blocked.length - named.size
  const moreClause = unnamed === 0 ? '' : `; ${unnamed} more ${unnamed === 1 ? 'eval has calls' : 'evals have calls'} that haven't started`
  if (rows.length > 0 && rows.every(row => row.state === 'late')) {
    const ids = rows.map(row => `#${row.id}`).join(', ')
    if (blocked.length === 0)
      return rows.length === 1
        ? `no late output yet \u2014 eval ${ids} settled; the calls it left running are finishing. Poll again to keep waiting.`
        : `no late output yet \u2014 evals ${ids} settled; the calls they left running are finishing. Poll again to keep waiting.`
    if (rows.length === 1)
      return `no late output yet \u2014 eval ${ids} settled; ${notStartedClause(rows[0]!.notYetStarted)}. Poll again to keep waiting.`
    const clauses = rows.filter(row => named.has(row.id)).map(row => `#${row.id}: ${notStartedClause(row.notYetStarted)}`)
    const others = rows.length > blocked.length ? '; the calls the others left running are finishing' : ''
    return `no late output yet \u2014 evals ${ids} settled; ${clauses.join('; ')}${moreClause}${others}. Poll again to keep waiting.`
  }
  const parts = rows.map(row => {
    const calls = named.has(row.id) ? `, and ${notStartedClause(row.notYetStarted)}` : ''
    switch (row.state) {
      case 'waiting':
        return `#${row.id} waiting for its turn`
      case 'running':
        return `#${row.id} running for ${formatDuration(row.runningMs)}${calls}`
      case 'detached':
        return `#${row.id} running for ${formatDuration(row.runningMs)} (detached: later evals run beside it)${calls}`
      case 'late':
        return named.has(row.id)
          ? `#${row.id} settled, and ${notStartedClause(row.notYetStarted)}`
          : `#${row.id} settled; calls it left running are finishing`
    }
  })
  const evals = rows.length === 1 ? 'eval' : 'evals'
  if (stillPending) return `${rows.length} ${evals} still pending: ${parts.join('; ')}${moreClause}.`
  return `no output yet \u2014 ${rows.length} ${evals} pending: ${parts.join('; ')}${moreClause}. Poll again to keep waiting.`
}

/** Official `enqueueReplStatus` element: the status text as a `repl-status` event. */
export function formatReplStatusEvent(rows: readonly ReplLedgerRow[], at = new Date(), stillPending = false): string {
  return `<event kind="${REPL_STATUS_EVENT_KIND}" at="${attribute(at.toISOString())}" pending="${rows.length}">${escapeContent(replStatusText(rows, stillPending))}</event>`
}

/**
 * Official `enqueueReplStatus`: queues the status line as a poll event for
 * the session's thread; one the queue refuses is only logged.
 */
export function enqueueReplStatus(session: ReplSession, rows: readonly ReplLedgerRow[], stillPending = false): void {
  const refused = (error: unknown) =>
    logForDebugging(`async REPL status line not delivered: ${error instanceof Error ? error.message : 'non-Error rejection'}`)
  try {
    void enqueuePollEvent({
      kind: REPL_STATUS_EVENT_KIND,
      element: formatReplStatusEvent(rows, new Date(), stillPending),
      agentId: session.agentId as never,
    }).catch(refused)
  } catch (error) {
    refused(error)
  }
}
