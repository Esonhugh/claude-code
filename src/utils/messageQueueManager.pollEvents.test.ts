import { afterEach, describe, expect, test } from 'bun:test'
import type { AgentId } from '../types/ids.js'
import {
  countRemainingWakePollEventsAfter,
  drainPollEventChunk,
  enqueue,
  enqueuePollEvent,
  getCommandQueueSnapshot,
  isWakingReplEvalEvent,
  POLL_EVENT_BYTES,
  POLL_EVENT_CHUNK_EVENTS,
  POLL_EVENT_QUEUE_CAP,
  pollEventWakes,
  resetCommandQueue,
  settlePollEventsDelivered,
  settlePollEventsDropped,
} from './messageQueueManager.js'

afterEach(() => resetCommandQueue())

const element = (n: number | string, kind = 'repl-eval', body = '') =>
  `<event kind="${kind}" at="2026-11-16T00:00:00.000Z" eval="${n}">${body}</event>`
const subagent = 'a-sub' as AgentId

describe('poll-event queue mode (official 2.1.325)', () => {
  test('the queue stamps a nonce first and queues a waking event at next priority', () => {
    void enqueuePollEvent({ kind: 'repl-eval', element: element(1) })
    void enqueuePollEvent({ kind: 'repl-status', element: element(2, 'repl-status'), wake: false })
    const [first, second] = getCommandQueueSnapshot()
    expect(first!.value).toMatch(/^<event nonce="[A-Za-z0-9_-]{8}" kind="repl-eval" at="2026-11-16T00:00:00.000Z" eval="1"><\/event>$/)
    expect(first).toMatchObject({ mode: 'poll-event', priority: 'next', isMeta: true, agentId: undefined })
    expect(first!.pollEvent).toMatchObject({ kind: 'repl-eval', envelope: first!.value, wake: true })
    expect(first!.value).toContain(`nonce="${first!.pollEvent!.nonce}"`)
    expect(second).toMatchObject({ priority: 'later', pollEvent: { wake: false } })
    expect(first!.pollEvent!.nonce).not.toBe(second!.pollEvent!.nonce)
  })

  test('a delivery holds at most 20 events, oldest first, and counts the waking ones left', () => {
    for (let n = 1; n <= POLL_EVENT_CHUNK_EVENTS + 3; n++) void enqueuePollEvent({ kind: 'repl-eval', element: element(n) })
    const first = drainPollEventChunk(undefined)
    expect(first.commands.map(cmd => cmd.pollEvent!.envelope.match(/eval="(\d+)"/)![1])).toEqual(
      Array.from({ length: POLL_EVENT_CHUNK_EVENTS }, (_, i) => String(i + 1)),
    )
    expect(first.remainingWakeCount).toBe(3)
    expect(drainPollEventChunk(undefined)).toMatchObject({ remainingWakeCount: 0 })
    expect(drainPollEventChunk(undefined)).toEqual({ commands: [], remainingWakeCount: 0 })
  })

  test('a delivery holds at most 32768 bytes, but always one event', () => {
    for (const n of [1, 2]) void enqueuePollEvent({ kind: 'repl-eval', element: element(n, 'repl-eval', 'x'.repeat(20_000)) })
    void enqueuePollEvent({ kind: 'repl-eval', element: element(3, 'repl-eval', 'x'.repeat(40_000)) })
    expect(drainPollEventChunk(undefined).commands).toHaveLength(1)
    expect(drainPollEventChunk(undefined).commands).toHaveLength(1)
    expect(drainPollEventChunk(undefined).commands).toHaveLength(1)
  })

  test('an envelope over its cap is refused, a larger one for an eval outcome', () => {
    const body = 'x'.repeat(POLL_EVENT_BYTES)
    expect(() => enqueuePollEvent({ kind: 'repl-status', element: element(1, 'repl-status', body) })).toThrow(
      /^poll event rejected: envelope is \d+ bytes after nonce stamping \(cap 49152\)$/,
    )
    void enqueuePollEvent({ kind: 'repl-eval', element: element(1, 'repl-eval', body) })
    expect(() => enqueuePollEvent({ kind: 'repl-eval', element: element(2, 'repl-eval', 'x'.repeat(163_840)) })).toThrow('(cap 163840)')
    expect(() => enqueuePollEvent({ kind: 'Bad', element: element(3) })).toThrow('poll event rejected: invalid kind')
    expect(getCommandQueueSnapshot()).toHaveLength(1)
  })

  test('the queue holds at most 1000 poll events', () => {
    for (let n = 0; n < POLL_EVENT_QUEUE_CAP; n++) void enqueuePollEvent({ kind: 'repl-eval', element: element(n) })
    expect(() => enqueuePollEvent({ kind: 'repl-eval', element: element(0) })).toThrow('poll event rejected: 1000 events already queued')
  })

  test("a drain takes only the agent's events and leaves other commands queued", () => {
    enqueue({ value: 'hi', mode: 'prompt' })
    void enqueuePollEvent({ kind: 'repl-eval', element: element(1), agentId: subagent })
    void enqueuePollEvent({ kind: 'repl-eval', element: element(2) })
    expect(drainPollEventChunk(subagent).commands.map(cmd => cmd.agentId)).toEqual([subagent])
    expect(getCommandQueueSnapshot().map(cmd => cmd.mode)).toEqual(['prompt', 'poll-event'])
    expect(countRemainingWakePollEventsAfter([...getCommandQueueSnapshot()])).toBe(0)
  })

  test('startsTurn:false, wake:false or a held event never starts a turn', () => {
    expect(pollEventWakes({ wake: true })).toBe(true)
    expect(pollEventWakes({ wake: true, startsTurn: false })).toBe(false)
    expect(pollEventWakes({ wake: false })).toBe(false)
    expect(pollEventWakes({ wake: true, passive: true })).toBe(false)
    void enqueuePollEvent({ kind: 'repl-eval', element: element(1) })
    void enqueuePollEvent({ kind: 'repl-eval', element: element(2), startsTurn: false })
    void enqueuePollEvent({ kind: 'repl-status', element: element(3, 'repl-status') })
    expect(getCommandQueueSnapshot().map(isWakingReplEvalEvent)).toEqual([true, false, false])
    expect(getCommandQueueSnapshot()[1]!.pollEvent!.startsTurn).toBe(false)
  })

  test('the promise settles when a delivery takes the event or it is dropped', async () => {
    const delivered = enqueuePollEvent({ kind: 'repl-eval', element: element(1) })
    const dropped = enqueuePollEvent({ kind: 'repl-eval', element: element(2) })
    const [first, second] = drainPollEventChunk(undefined).commands
    settlePollEventsDelivered([first!])
    settlePollEventsDropped([second!], 'queue cleared')
    await expect(delivered).resolves.toBeUndefined()
    await expect(dropped).rejects.toThrow('poll event discarded undelivered: queue cleared')
  })
})
