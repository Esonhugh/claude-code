import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { getExtendedCacheTtlEnabled } from '../../services/api/claude.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  drainPollEventChunk,
  getCommandQueueSnapshot,
  settlePollEventsDelivered,
  subscribeToCommandQueue,
} from '../../utils/messageQueueManager.js'
import { isReplEventDeliveryEnabled, isReplSpliceWaitEnabled } from '../REPLTool/codeModeGate.js'
import { POLL_TOOL_NAME, REPL_TOOL_NAME } from '../REPLTool/constants.js'
import { isMainThreadSubagent, stopPendingOnAbort } from '../REPLTool/REPLTool.js'
import {
  enqueueReplStatus,
  findReplSession,
  formatReplStatus,
  MAIN_REPL_SESSION,
  noteReplStatusLine,
  onReplLedgerChange,
  outstandingReplEvals,
  replLedger,
  type ReplSession,
  takeReplEventChunk,
  takeReplLateMessages,
  takeReplStatusLineGiven,
  takeUnwaitedReplEvals,
  waitForReplEvent,
} from '../REPLTool/sessions.js'
import { formatPollDelivery } from './delivery.js'
import { DESCRIPTION, NO_PENDING_EVENTS, PROMPT } from './prompt.js'

/** Official HM (the default 5-minute prompt cache TTL) and the 1-hour one. */
const CACHE_TTL_MS = 300_000
const EXTENDED_CACHE_TTL_MS = 3_600_000
/** Official CWt (POLL_CACHE_TTL_MARGIN_MS): a wait ends this long before the cache expires. */
const CACHE_TTL_MARGIN_MS = 30_000
export const POLL_WAIT_MS = CACHE_TTL_MS - CACHE_TTL_MARGIN_MS

let waitOverrideMs: number | undefined

export function setPollWaitForTesting(ms?: number): void {
  waitOverrideMs = ms
}

/**
 * Official `(cacheTtlMs ?? HM) - CWt`: the main thread waits within the TTL
 * its prompt cache is written with (`lq()`, the last main-thread request's);
 * a subagent's is not tracked, so it waits within the default one.
 */
function pollWaitMs(agentId: string | undefined): number {
  if (waitOverrideMs !== undefined) return waitOverrideMs
  if (agentId !== undefined) return POLL_WAIT_MS
  const ttl = getExtendedCacheTtlEnabled('repl_main_thread') ? EXTENDED_CACHE_TTL_MS : CACHE_TTL_MS
  return ttl - CACHE_TTL_MARGIN_MS
}

/** Official refusal for an agent without the async lane (`jy()` on, so the Code Mode wording). */
const REFUSED_MESSAGE = `${POLL_TOOL_NAME} isn't available here and isn't needed: each ${REPL_TOOL_NAME} call you make here waits for its script to finish and returns the result.`

/** Official `tryBeginPollCall`/`endPollCall`: one Poll at a time per agent (the main thread keyed as itself). */
const activePolls = new Set<string>()

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    content: z.string().describe(`Rendered event envelopes, or "${NO_PENDING_EVENTS}"`),
    eventCount: z.number().int().describe('Number of events delivered in this result'),
    remainingWakeCount: z
      .number()
      .int()
      .describe('Wake events still queued after this chunk; they follow in the next delivery'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

const NOTHING: Output = { content: NO_PENDING_EVENTS, eventCount: 0, remainingWakeCount: 0 }

function hasQueuedInput(agentId: string | undefined): boolean {
  return getCommandQueueSnapshot().some(cmd => cmd.mode === 'prompt' && cmd.agentId === agentId)
}

/** Aborts when `signal` does or the user types something, so their message isn't held behind the wait. */
function untilUserInput(agentId: string | undefined, signal: AbortSignal): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const stop = () => controller.abort()
  const check = () => {
    if (hasQueuedInput(agentId)) stop()
  }
  const unsubscribe = subscribeToCommandQueue(check)
  check()
  if (signal.aborted) stop()
  else signal.addEventListener('abort', stop, { once: true })
  return {
    signal: controller.signal,
    dispose() {
      unsubscribe()
      signal.removeEventListener('abort', stop)
    },
  }
}

/** The events of one chunk as one delivery (official `nce`). */
function deliver(session: ReplSession): Output | undefined {
  const { events, remaining } = takeReplEventChunk(session)
  if (events.length === 0) return undefined
  return {
    content: formatPollDelivery(events.map(event => event.text), remaining),
    eventCount: events.length,
    remainingWakeCount: remaining,
  }
}

async function poll(session: ReplSession, context: ToolUseContext): Promise<Output> {
  const signal = context.abortController.signal
  stopPendingOnAbort(session, signal)
  const ready = deliver(session)
  if (ready) return ready
  if (session.pending.size === 0) return NOTHING
  const wake = untilUserInput(session.agentId, signal)
  const deadline = Date.now() + pollWaitMs(session.agentId)
  try {
    while (session.pending.size > 0 && !wake.signal.aborted && !session.released) {
      const left = deadline - Date.now()
      if (left <= 0) break
      await waitForReplEvent(session, left, wake.signal)
      const delivered = deliver(session)
      if (delivered) return delivered
    }
  } finally {
    wake.dispose()
  }
  // Official: at the deadline the status line is queued and delivered as an event of its own.
  if (session.pending.size > 0 && !wake.signal.aborted && !session.released) {
    return { content: formatReplStatus(session), eventCount: 1, remainingWakeCount: 0 }
  }
  return NOTHING
}

/** Resolves on the next queue or ledger change, a release, `ms` passing or `signal` aborting. */
function nextChange(session: ReplSession, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer)
      unsubscribeQueue()
      unsubscribeLedger()
      signal.removeEventListener('abort', done)
      session.waiters.delete(done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    const unsubscribeQueue = subscribeToCommandQueue(done)
    const unsubscribeLedger = onReplLedgerChange(session, done)
    signal.addEventListener('abort', done, { once: true })
    session.waiters.add(done)
  })
}

/**
 * Official `Mso` (2.1.325 chunk-pg2sb68f.js) under the splice wait: delivers
 * the thread's queued poll events, one chunk, waiting for them while evals
 * are outstanding. At the deadline the status line is queued and delivered
 * as an event of its own.
 */
async function pollQueue(session: ReplSession, context: ToolUseContext): Promise<Output> {
  const signal = context.abortController.signal
  const agentId = session.agentId
  stopPendingOnAbort(session, signal)
  takeReplStatusLineGiven(session)
  const deadline = Date.now() + pollWaitMs(agentId)
  let statusQueued = false
  let eventCount = 0
  try {
    for (;;) {
      if (signal.aborted || session.released) return NOTHING
      const { commands, remainingWakeCount } = drainPollEventChunk(agentId as never)
      if (commands.length > 0) {
        settlePollEventsDelivered(commands)
        eventCount = commands.length
        // Not filled: official `Itn` names the tools used since the last delivery (see toolsUsedLine).
        const envelopes = commands.map(cmd => cmd.pollEvent!.envelope)
        return { content: formatPollDelivery(envelopes, remainingWakeCount), eventCount, remainingWakeCount }
      }
      if (hasQueuedInput(agentId)) return NOTHING
      if (outstandingReplEvals(session) === 0 || statusQueued) return NOTHING
      const left = deadline - Date.now()
      if (left <= 0) {
        enqueueReplStatus(session, replLedger(session))
        noteReplStatusLine(session)
        statusQueued = true
        continue
      }
      await nextChange(session, left, signal)
    }
  } finally {
    if (eventCount > 0) takeUnwaitedReplEvals(session)
  }
}

export const PollTool = buildTool({
  name: POLL_TOOL_NAME,
  searchHint: 'wait for and receive queued harness events',
  maxResultSizeChars: 200_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    // Official HR(): only a session launched in auto or bypassPermissions.
    return isReplEventDeliveryEnabled()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  userFacingName() {
    return 'Poll'
  },
  renderToolUseMessage() {
    return ''
  },
  renderToolResultMessage() {
    return null
  },
  async call(_input, context) {
    // Official: an agent without the async lane has nothing to poll for.
    if (context.agentId !== undefined && !isMainThreadSubagent(context)) throw new Error(REFUSED_MESSAGE)
    const key = context.agentId ?? MAIN_REPL_SESSION
    // Official: a second Poll while one waits returns at once.
    if (activePolls.has(key)) return { data: NOTHING }
    activePolls.add(key)
    try {
      const session = findReplSession(key)
      if (!session) return { data: NOTHING }
      const data = isReplSpliceWaitEnabled() ? await pollQueue(session, context) : await poll(session, context)
      return { data, newMessages: takeReplLateMessages(session) as never }
    } finally {
      activePolls.delete(key)
    }
  },
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    return { tool_use_id: toolUseID, type: 'tool_result', content: data.content }
  },
} satisfies ToolDef<InputSchema, Output>)
