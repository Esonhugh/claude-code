import type { Message } from '../../types/message.js'
import type { QueuedCommand } from '../../types/textInputTypes.js'
import { REPL_STATUS_EVENT_KIND } from '../../utils/messageQueueManager.js'
import { isReplSpliceWaitEnabled } from './codeModeGate.js'
import {
  enqueueReplStatus,
  findReplSession,
  MAIN_REPL_SESSION,
  onReplLedgerChange,
  replLedger,
  type ReplLedgerRow,
  takeReplLateMessages,
  takeReplStatusLineGiven,
  takeUnwaitedReplEvals,
} from './sessions.js'

/** Official `Z7a()` (replSpliceEventBatching): news is batched this long after the latest, and at most this long after the first. */
export const REPL_SPLICE_EVENT_BATCHING = { debounceMs: 750, maxWaitMs: 3000 }

export type WaitForNewsOptions = {
  /** The news so far; the wait ends once it holds something and stays quiet. */
  news: () => readonly unknown[]
  /** Calls the listener on every change that may bring news; returns the unsubscribe. */
  subscribe: (listener: () => void) => () => void
  signal: AbortSignal
  /** Aborting counts as news (the awaited outcomes all went out). */
  settled?: AbortSignal
  debounceMs: number
  maxWaitMs: number
}

/**
 * Official `eYa` (waitForNews, 2.1.325 chunk-7cqv1j64.js): resolves
 * `debounceMs` after the latest news, or `maxWaitMs` after the first, or at
 * once when `signal` aborts. With no news it waits without limit.
 */
export function waitForNews({ news, subscribe, signal, settled, debounceMs, maxWaitMs }: WaitForNewsOptions): Promise<void> {
  return new Promise(resolve => {
    let done = false
    let quiet: ReturnType<typeof setTimeout> | undefined
    let cap: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = subscribe(check)
    function finish() {
      if (done) return
      done = true
      clearTimeout(quiet)
      clearTimeout(cap)
      unsubscribe()
      signal.removeEventListener('abort', finish)
      settled?.removeEventListener('abort', check)
      resolve()
    }
    function check() {
      if (done || (news().length === 0 && settled?.aborted !== true)) return
      clearTimeout(quiet)
      quiet = setTimeout(finish, debounceMs)
      cap ??= setTimeout(finish, maxWaitMs)
    }
    if (signal.aborted) {
      finish()
      return
    }
    signal.addEventListener('abort', finish, { once: true })
    settled?.addEventListener('abort', check, { once: true })
    check()
  })
}

/** Official `Uu`: the wait runs after every tool round but a main thread's last allowed one. */
export function shouldWaitAfterToolCalls({
  foldSuspended = false,
  isMainThread,
  lastIteration,
}: {
  foldSuspended?: boolean
  isMainThread: boolean
  lastIteration: boolean
}): boolean {
  return !foldSuspended && (!isMainThread || !lastIteration)
}

export type SpliceWaitQueue = {
  /** The commands this thread's next request would take in (official `Ti`). */
  queued: () => readonly QueuedCommand[]
  subscribe: (listener: () => void) => () => void
}

function pendingRows(rows: readonly ReplLedgerRow[]): ReplLedgerRow[] {
  return rows.filter(row => row.state !== 'late')
}

/**
 * Official `Bu` (2.1.325 chunk-7qa83fnn.js) under `isReplSpliceWaitEnabled`:
 * after a reply's tool calls, waits for the outcomes of the scripts nothing
 * has waited on yet, so they are spliced into this turn. The wait ends once
 * their outcomes are queued, or the user sends something, and the news has
 * been quiet for the debounce; evals still pending then get a status line.
 */
export async function waitForReplScriptsAfterToolCalls(
  agentId: string | undefined,
  signal: AbortSignal,
  queue: SpliceWaitQueue,
): Promise<void> {
  if (!isReplSpliceWaitEnabled()) return
  const session = findReplSession(agentId ?? MAIN_REPL_SESSION)
  if (!session) return
  const unwaited = takeUnwaitedReplEvals(session)
  const statusGiven = takeReplStatusLineGiven(session)
  if (signal.aborted) return
  if (unwaited.length === 0) {
    const rows = pendingRows(replLedger(session))
    if (!statusGiven && rows.some(row => row.state === 'detached')) enqueueReplStatus(session, rows, true)
    return
  }
  const settled = new AbortController()
  const check = () => {
    if (!unwaited.some(id => session.undelivered.has(id))) settled.abort()
  }
  const unsubscribe = onReplLedgerChange(session, check)
  check()
  const news = () => queue.queued().filter(cmd => !(cmd.mode === 'poll-event' && cmd.pollEvent?.kind === REPL_STATUS_EVENT_KIND))
  try {
    await waitForNews({ news, subscribe: queue.subscribe, signal, settled: settled.signal, ...REPL_SPLICE_EVENT_BATCHING })
  } finally {
    unsubscribe()
  }
  const rows = pendingRows(replLedger(session))
  if (rows.length > 0 && !signal.aborted) {
    const stillPending = rows.some(row => row.state === 'detached') && unwaited.some(id => !session.undelivered.has(id))
    enqueueReplStatus(session, rows, stillPending)
  }
}

/** How long an aborted turn waits for the scripts it stopped to report. */
const STOPPED_ROWS_WAIT_MS = 1000

/**
 * Official 2.1.329: the rows of the scripts a turn's abort stopped (the calls
 * they left running among them) are recorded with the interruption, not with
 * a later delivery. Scripts still to report get `waitMs` to do so.
 */
export async function takeStoppedReplRows(agentId: string | undefined, waitMs = STOPPED_ROWS_WAIT_MS): Promise<Message[]> {
  const session = findReplSession(agentId ?? MAIN_REPL_SESSION)
  if (!session) return []
  if (session.undelivered.size > 0)
    await new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer)
        unsubscribe()
        resolve()
      }
      const unsubscribe = onReplLedgerChange(session, () => {
        if (session.undelivered.size === 0) done()
      })
      const timer = setTimeout(done, waitMs)
    })
  return takeReplLateMessages(session)
}
