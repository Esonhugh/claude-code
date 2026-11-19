import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { getIsInteractive, setIsInteractive } from '../../bootstrap/state.js'
import type { QueuedCommand } from '../../types/textInputTypes.js'
import {
  enqueue,
  getCommandQueueSnapshot,
  REPL_STATUS_EVENT_KIND,
  resetCommandQueue,
  subscribeToCommandQueue,
} from '../../utils/messageQueueManager.js'
import { noteReplLaunchPermissionMode, resetCodeModeGateForTesting } from './codeModeGate.js'
import {
  detachReplEval,
  dispatchReplEval,
  getReplSession,
  MAIN_REPL_SESSION,
  markReplEvalDelivered,
  noteReplStatusLine,
  releaseAllReplSessions,
  startReplEval,
} from './sessions.js'
import { shouldWaitAfterToolCalls, waitForNews, waitForReplScriptsAfterToolCalls } from './spliceWait.js'

const savedCodeMode = process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE
const savedEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
const savedInteractive = getIsInteractive()

beforeAll(() => {
  process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = '1'
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
  setIsInteractive(true)
  resetCodeModeGateForTesting()
  noteReplLaunchPermissionMode('bypassPermissions')
})
afterAll(() => {
  if (savedCodeMode === undefined) delete process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE
  else process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = savedCodeMode
  if (savedEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT
  else process.env.CLAUDE_CODE_ENTRYPOINT = savedEntrypoint
  setIsInteractive(savedInteractive)
  resetCodeModeGateForTesting()
})
afterEach(() => {
  releaseAllReplSessions()
  resetCommandQueue()
})

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Official eYa as a harness: a list the test pushes to, with listeners. */
function newsSource() {
  const items: unknown[] = []
  const listeners = new Set<() => void>()
  return {
    news: () => items,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    push(item: unknown) {
      items.push(item)
      for (const listener of [...listeners]) listener()
    },
    listeners,
  }
}

describe('waitForNews (official eYa)', () => {
  test('resolves the debounce after the latest news', async () => {
    const source = newsSource()
    const started = Date.now()
    const done = waitForNews({ ...source, signal: new AbortController().signal, debounceMs: 40, maxWaitMs: 1000 })
    setTimeout(() => source.push(1), 20)
    setTimeout(() => source.push(2), 50)
    await done
    expect(Date.now() - started).toBeGreaterThanOrEqual(85)
    expect(source.listeners.size).toBe(0)
  })

  test('steady news ends at the max wait', async () => {
    const source = newsSource()
    const timer = setInterval(() => source.push(0), 10)
    const started = Date.now()
    await waitForNews({ ...source, signal: new AbortController().signal, debounceMs: 30, maxWaitMs: 120 })
    clearInterval(timer)
    expect(Date.now() - started).toBeLessThan(200)
  })

  test('with no news it waits until the signal aborts', async () => {
    const source = newsSource()
    const controller = new AbortController()
    let resolved = false
    const done = waitForNews({ ...source, signal: controller.signal, debounceMs: 5, maxWaitMs: 10 }).then(() => (resolved = true))
    await sleep(40)
    expect(resolved).toBe(false)
    controller.abort()
    await done
    expect(resolved).toBe(true)
  })

  test('the settled signal counts as news', async () => {
    const source = newsSource()
    const settled = new AbortController()
    const done = waitForNews({ ...source, signal: new AbortController().signal, settled: settled.signal, debounceMs: 10, maxWaitMs: 100 })
    settled.abort()
    await done
  })
})

describe('shouldWaitAfterToolCalls (official Uu)', () => {
  test('a main thread skips its last allowed round; a subagent never does', () => {
    expect(shouldWaitAfterToolCalls({ isMainThread: true, lastIteration: false })).toBe(true)
    expect(shouldWaitAfterToolCalls({ isMainThread: true, lastIteration: true })).toBe(false)
    expect(shouldWaitAfterToolCalls({ isMainThread: false, lastIteration: true })).toBe(true)
    expect(shouldWaitAfterToolCalls({ isMainThread: false, lastIteration: false, foldSuspended: true })).toBe(false)
  })
})

const mainQueue = {
  queued: () => getCommandQueueSnapshot().filter(cmd => cmd.agentId === undefined),
  subscribe: subscribeToCommandQueue,
}
const statusEvents = () =>
  getCommandQueueSnapshot().filter(cmd => cmd.mode === 'poll-event' && cmd.pollEvent?.kind === REPL_STATUS_EVENT_KIND)

describe('waitForReplScriptsAfterToolCalls (official Bu)', () => {
  test('nothing unwaited and a detached eval: one status line, still pending', async () => {
    const session = getReplSession(MAIN_REPL_SESSION)
    dispatchReplEval(session, 1, 'await sleep(40000)')
    startReplEval(session, 1)
    detachReplEval(session, 1)
    session.unwaited.clear()
    await waitForReplScriptsAfterToolCalls(undefined, new AbortController().signal, mainQueue)
    await sleep(0)
    expect(statusEvents()).toHaveLength(1)
    expect(statusEvents()[0]!.pollEvent!.envelope).toContain('1 eval still pending: #1 running for')
  })

  test('nothing unwaited after a status line was given: no new one', async () => {
    const session = getReplSession(MAIN_REPL_SESSION)
    dispatchReplEval(session, 1, 'x')
    startReplEval(session, 1)
    detachReplEval(session, 1)
    session.unwaited.clear()
    noteReplStatusLine(session)
    await waitForReplScriptsAfterToolCalls(undefined, new AbortController().signal, mainQueue)
    await sleep(0)
    expect(statusEvents()).toHaveLength(0)
    expect(session.statusLineGiven).toBe(false)
  })

  test('ends the debounce after the reply’s evals were delivered', async () => {
    const session = getReplSession(MAIN_REPL_SESSION)
    dispatchReplEval(session, 1, 'x')
    startReplEval(session, 1)
    const started = Date.now()
    setTimeout(() => markReplEvalDelivered(session, 1), 30)
    await waitForReplScriptsAfterToolCalls(undefined, new AbortController().signal, mainQueue)
    expect(Date.now() - started).toBeGreaterThanOrEqual(750)
    expect(session.unwaited.size).toBe(0)
    // The eval is still in the ledger (its outcome went out first), so a status follows.
    await sleep(0)
    expect(statusEvents()).toHaveLength(1)
  })

  test('a user message ends the wait; the abort signal ends it at once', async () => {
    const session = getReplSession(MAIN_REPL_SESSION)
    dispatchReplEval(session, 1, 'x')
    startReplEval(session, 1)
    const controller = new AbortController()
    const done = waitForReplScriptsAfterToolCalls(undefined, controller.signal, mainQueue)
    enqueue({ value: 'hi', mode: 'prompt' } as QueuedCommand)
    const started = Date.now()
    controller.abort()
    await done
    expect(Date.now() - started).toBeLessThan(100)
    await sleep(0)
    expect(statusEvents()).toHaveLength(0)
  })
})
