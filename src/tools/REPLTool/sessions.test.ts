import { afterEach, describe, expect, test } from 'bun:test'
import {
  detachReplEval,
  dispatchReplEval,
  endLateReplEval,
  finishReplEval,
  getReplSession,
  markReplEvalDelivered,
  noteReplStatusLine,
  onReplLedgerChange,
  releaseAllReplSessions,
  replLedger,
  startReplEval,
  takeReplStatusLineGiven,
  takeUnwaitedReplEvals,
} from './sessions.js'

afterEach(() => releaseAllReplSessions())

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
