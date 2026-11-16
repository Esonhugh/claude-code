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
import { isReplEventDeliveryEnabled } from '../REPLTool/codeModeGate.js'
import { POLL_TOOL_NAME, REPL_TOOL_NAME } from '../REPLTool/constants.js'
import { isMainThreadSubagent } from '../REPLTool/REPLTool.js'
import {
  enqueueReplStatus,
  findReplSession,
  MAIN_REPL_SESSION,
  noteReplStatusLine,
  onReplLedgerChange,
  outstandingReplEvals,
  replLedger,
  type ReplSession,
  takeReplLateMessages,
  takeReplStatusLineGiven,
  takeUnwaitedReplEvals,
} from '../REPLTool/sessions.js'
import { formatPollDelivery } from './delivery.js'
import { DESCRIPTION, NO_PENDING_EVENTS, PROMPT } from './prompt.js'
import { toolsUsedForDelivery } from './toolsUsed.js'

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

/** Official `X`: an image or PDF an event carries. */
const mediaSchema = lazySchema(() =>
  z.union([
    z.object({
      type: z.literal('image'),
      source: z.object({
        type: z.literal('base64'),
        media_type: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
        data: z.string(),
      }),
    }),
    z.object({
      type: z.literal('document'),
      source: z.object({ type: z.literal('base64'), media_type: z.literal('application/pdf'), data: z.string() }),
    }),
  ]),
)

/** Official `Iso`. No event on this path carries media, provenance or declared fields yet. */
const outputSchema = lazySchema(() =>
  z.object({
    content: z.string().describe(`Rendered event envelopes, or "${NO_PENDING_EVENTS}"`),
    eventCount: z.number().int().describe('Number of events delivered in this result'),
    remainingWakeCount: z
      .number()
      .int()
      .describe('Wake events still queued after this chunk; they follow in the next delivery'),
    media: z
      .array(z.array(mediaSchema()))
      .optional()
      .describe("Each delivered event's images and documents, 1:1 with the events. Absent when none has any"),
    toolsUsed: z.array(z.string()).optional(),
    provenance: z
      .array(
        z
          .object({
            authority: z.enum(['human-principal', 'human-other', 'peer-agent', 'world-event']),
            senderId: z.string().optional(),
            senderText: z.string().optional(),
          })
          .nullable(),
      )
      .optional(),
    declared: z
      .array(z.object({ kind: z.string(), at: z.string(), fields: z.record(z.string(), z.unknown()) }).nullable())
      .optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

const NOTHING: Output = { content: NO_PENDING_EVENTS, eventCount: 0, remainingWakeCount: 0 }

function hasQueuedInput(agentId: string | undefined): boolean {
  return getCommandQueueSnapshot().some(cmd => cmd.mode === 'prompt' && cmd.agentId === agentId)
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
 * Official `Mso` (2.1.325 chunk-pg2sb68f.js): delivers
 * the thread's queued poll events, one chunk, waiting for them while evals
 * are outstanding. At the deadline the status line is queued and delivered
 * as an event of its own.
 */
async function pollQueue(session: ReplSession, context: ToolUseContext): Promise<Output> {
  const signal = context.abortController.signal
  const agentId = session.agentId
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
        const envelopes = commands.map(cmd => cmd.pollEvent!.envelope)
        const toolsUsed = toolsUsedForDelivery(commands, context.messages)
        return {
          content: formatPollDelivery(envelopes, remainingWakeCount, toolsUsed),
          eventCount,
          remainingWakeCount,
          ...(toolsUsed.length > 0 && { toolsUsed }),
          provenance: commands.map(() => null),
        }
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
      const data = await pollQueue(session, context)
      return { data, newMessages: takeReplLateMessages(session) as never }
    } finally {
      activePolls.delete(key)
    }
  },
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    return { tool_use_id: toolUseID, type: 'tool_result', content: data.content }
  },
} satisfies ToolDef<InputSchema, Output>)
