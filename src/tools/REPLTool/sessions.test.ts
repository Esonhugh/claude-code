import { afterEach, describe, expect, test } from 'bun:test'
import { getCommandQueueSnapshot, resetCommandQueue } from '../../utils/messageQueueManager.js'
import {
  detachReplEval,
  dispatchReplEval,
  endLateReplEval,
  enqueueReplStatus,
  finishReplEval,
  formatReplStatusEvent,
  getReplSession,
  markReplEvalDelivered,
  noteReplStatusLine,
  onReplLedgerChange,
  releaseAllReplSessions,
  replLedger,
  replStatusText,
  type ReplEvalState,
  type ReplLedgerRow,
  type ReplNotYetStartedCall,
  startReplEval,
  takeReplStatusLineGiven,
  takeUnwaitedReplEvals,
} from './sessions.js'

afterEach(() => {
  releaseAllReplSessions()
  resetCommandQueue()
})

let nextKey = 0
const freshSession = () => getReplSession(`ledger-${nextKey++}`)

describe('eval ledger', () => {
  test('an eval goes waiting, running, detached, then leaves when it finishes', () => {
    const session = freshSession()
    dispatchReplEval(session, 1, '  await Bash({command:\n  "sleep 40"})  ')
    expect(replLedger(session, 0)).toEqual([
      { id: 1, state: 'waiting', runningMs: 0, snippet: 'await Bash({command: "sleep 40"})', notYetStarted: [] },
    ])
    startReplEval(session, 1)
    const started = session.ledger.get(1)!.startedAt!
    expect(replLedger(session, started + 1500)[0]).toMatchObject({ state: 'running', runningMs: 1500 })
    detachReplEval(session, 1)
    expect(replLedger(session)[0]!.state).toBe('detached')
    finishReplEval(session, 1)
    expect(replLedger(session)).toEqual([])
    expect(session.depth).toBe(0)
    // Finished is not delivered: the outcome still has to go out.
    expect([...session.undelivered]).toEqual([1])
    markReplEvalDelivered(session, 1)
    expect(session.undelivered.size).toBe(0)
    expect(session.unwaited.size).toBe(0)
  })

  test('the snippet is the code with whitespace collapsed, first 100 characters', () => {
    const session = freshSession()
    dispatchReplEval(session, 1, `x\n\n${'y'.repeat(200)}`)
    expect(replLedger(session)[0]!.snippet).toBe(`x ${'y'.repeat(98)}`)
  })

  test('depth counts waiting evals as well as running ones', () => {
    const session = freshSession()
    dispatchReplEval(session, 1, 'a')
    dispatchReplEval(session, 2, 'b')
    startReplEval(session, 1)
    expect(session.depth).toBe(2)
    expect(replLedger(session).map(row => row.state)).toEqual(['running', 'waiting'])
  })

  test('a late eval leaves depth when it finishes and the ledger when its calls end', () => {
    const session = freshSession()
    dispatchReplEval(session, 1, 'a')
    startReplEval(session, 1)
    finishReplEval(session, 1, { late: true })
    expect(session.depth).toBe(0)
    expect(replLedger(session)[0]!.state).toBe('late')
    endLateReplEval(session, 1)
    expect(replLedger(session)).toEqual([])
  })

  test('takeUnwaited takes all, or only the given ids, once', () => {
    const session = freshSession()
    for (const id of [1, 2, 3]) dispatchReplEval(session, id, String(id))
    expect(takeUnwaitedReplEvals(session, new Set([2, 9]))).toEqual([2])
    expect(takeUnwaitedReplEvals(session)).toEqual([1, 3])
    expect(takeUnwaitedReplEvals(session)).toEqual([])
    // Waited on is still undelivered.
    expect([...session.undelivered]).toEqual([1, 2, 3])
  })

  test('the status-line flag is taken once and a dispatch clears it', () => {
    const session = freshSession()
    noteReplStatusLine(session)
    expect(takeReplStatusLineGiven(session)).toBe(true)
    expect(takeReplStatusLineGiven(session)).toBe(false)
    noteReplStatusLine(session)
    dispatchReplEval(session, 1, 'a')
    expect(takeReplStatusLineGiven(session)).toBe(false)
  })

  test('listeners hear every change until they unsubscribe', () => {
    const session = freshSession()
    let changes = 0
    const off = onReplLedgerChange(session, () => changes++)
    dispatchReplEval(session, 1, 'a')
    startReplEval(session, 1)
    detachReplEval(session, 1)
    finishReplEval(session, 1)
    markReplEvalDelivered(session, 1)
    expect(changes).toBe(5)
    off()
    dispatchReplEval(session, 2, 'b')
    expect(changes).toBe(5)
  })
})

const row = (id: number, state: ReplEvalState, runningMs = 0, notYetStarted: ReplNotYetStartedCall[] = []): ReplLedgerRow => ({
  id,
  state,
  runningMs,
  snippet: '',
  notYetStarted,
})
const calls = (...names: string[]) => names.map((toolName, i) => ({ toolName, waitingMs: (i + 1) * 1000 }))

describe('repl-status wording (official 2.1.325 chunk-2p8jywjd.js)', () => {
  test.each([
    [
      'waiting, running and detached',
      [row(1, 'waiting'), row(2, 'running', 10_000), row(3, 'detached', 65_000)],
      false,
      'no output yet \u2014 3 evals pending: #1 waiting for its turn; #2 running for 10s; #3 running for 1m 5s (detached: later evals run beside it). Poll again to keep waiting.',
    ],
    [
      'still pending after some settled',
      [row(1, 'detached', 31_000)],
      true,
      '1 eval still pending: #1 running for 31s (detached: later evals run beside it).',
    ],
    [
      'a call that has not started',
      [row(1, 'running', 20_000, [{ toolName: 'Bash', waitingMs: 12_000 }])],
      false,
      "no output yet \u2014 1 eval pending: #1 running for 20s, and its Bash call hasn't started after 12s (it may be waiting for the user to answer a permission prompt). Poll again to keep waiting.",
    ],
    [
      'at most 5 calls named',
      [row(1, 'detached', 40_000, calls('A', 'B', 'C', 'D', 'E', 'F', 'G'))],
      true,
      "1 eval still pending: #1 running for 40s (detached: later evals run beside it), and 7 of its calls haven't started: A after 1s, B after 2s, C after 3s, D after 4s, E after 5s and 2 more (they may be waiting for the user to answer a permission prompt).",
    ],
    [
      'at most 3 evals named',
      [1, 2, 3, 4, 5].map(id => row(id, 'running', 2000, calls('Read'))),
      false,
      `no output yet \u2014 5 evals pending: ${[1, 2, 3]
        .map(id => `#${id} running for 2s, and its Read call hasn't started after 1s (it may be waiting for the user to answer a permission prompt)`)
        .join('; ')}; #4 running for 2s; #5 running for 2s; 2 more evals have calls that haven't started. Poll again to keep waiting.`,
    ],
    [
      'a late eval among running ones',
      [row(1, 'running', 5000), row(2, 'late')],
      false,
      'no output yet \u2014 2 evals pending: #1 running for 5s; #2 settled; calls it left running are finishing. Poll again to keep waiting.',
    ],
    [
      'one late eval',
      [row(4, 'late')],
      false,
      'no late output yet \u2014 eval #4 settled; the calls it left running are finishing. Poll again to keep waiting.',
    ],
    [
      'late evals',
      [row(1, 'late'), row(2, 'late')],
      false,
      'no late output yet \u2014 evals #1, #2 settled; the calls they left running are finishing. Poll again to keep waiting.',
    ],
    [
      'one late eval with a call not started',
      [row(1, 'late', 0, calls('Edit'))],
      false,
      "no late output yet \u2014 eval #1 settled; its Edit call hasn't started after 1s (it may be waiting for the user to answer a permission prompt). Poll again to keep waiting.",
    ],
    [
      'late evals, one with a call not started',
      [row(1, 'late', 0, calls('Edit')), row(2, 'late')],
      false,
      "no late output yet \u2014 evals #1, #2 settled; #1: its Edit call hasn't started after 1s (it may be waiting for the user to answer a permission prompt); the calls the others left running are finishing. Poll again to keep waiting.",
    ],
  ] as const)('%s', (_name, rows, stillPending, text) => {
    expect(replStatusText(rows as ReplLedgerRow[], stillPending)).toBe(text)
  })

  test('the element carries the pending count and escapes its text', () => {
    expect(formatReplStatusEvent([row(1, 'waiting')], new Date('2026-11-16T00:00:00.000Z'))).toBe(
      '<event kind="repl-status" at="2026-11-16T00:00:00.000Z" pending="1">no output yet \u2014 1 eval pending: #1 waiting for its turn. Poll again to keep waiting.</event>',
    )
  })

  test("enqueueReplStatus queues the element as a poll event for the session's thread", () => {
    enqueueReplStatus(getReplSession('a-status'), [row(1, 'detached', 31_000)], true)
    const [queued] = getCommandQueueSnapshot()
    expect(queued).toMatchObject({ mode: 'poll-event', agentId: 'a-status', pollEvent: { kind: 'repl-status', wake: true } })
    expect(queued!.value).toMatch(
      /^<event nonce="[A-Za-z0-9_-]{8}" kind="repl-status" at="[^"]+" pending="1">1 eval still pending: #1 running for 31s \(detached: later evals run beside it\)\.<\/event>$/,
    )
  })
})
