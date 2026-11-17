import { randomUUID } from 'crypto'
import { z } from 'zod/v4'
import { buildTool, type Tool, type ToolDef, toolMatchesName, type ToolUseContext, type Tools } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { getAgentContext } from '../../utils/agentContext.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
import { isAutoModeActive } from '../../utils/permissions/autoModeState.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import { saveCodeMode } from '../../utils/sessionStorage.js'
import { isInProcessTeammate } from '../../utils/teammateContext.js'
import { getCurrentSubagentDepth } from '../AgentTool/subagentDepth.js'
import { isCodeModeEnabled } from './codeModeGate.js'
import { isReplModeEnabled, POLL_TOOL_NAME, REPL_ASYNC_WALL_CAP_MS, REPL_TOOL_NAME } from './constants.js'
import {
  formatReplOutput,
  REPL_MAX_TIMEOUT_MS,
  REPL_OUTPUT_TOTAL_CHARS,
  type ReplRunResult,
  type ReplToolDescription,
} from './executor/host.js'
import { REPL_HELPERS_PRELUDE } from './helpers.js'
import { getReplPrompt, schemaToTypeScript, toolInputSchema } from './prompt.js'
import {
  deliverReplEvent,
  detachReplEval,
  dispatchReplEval,
  finishReplEval,
  formatReplEvalEvent,
  getReplSession,
  MAIN_REPL_SESSION,
  replCancelledBeforeStartText,
  startReplEval,
  takeReplLateMessages,
} from './sessions.js'
import { isUserStop, partwayNote, replStopOf, replStopReport, type ReplStop } from './stopReport.js'
import { createReplToolHost, getReplCallableTools, type ReplToolDescriptor } from './toolWrappers.js'
import { renderToolUseMessage } from './UI.js'
import { collectResultBlocks, resultBlockContent } from './resultBlocks.js'

export const REPL_ALIAS = 'Eval'
export const REPL_USER_FACING_NAME = 'Code'
/** LocalMainSessionTask's subagentName: a backgrounded main session (official `isMainSession`). */
const MAIN_SESSION_SUBAGENT_NAME = 'main-session'

/** Official `Wo` (new-context notice), shown on the first result in a context that lost earlier state. */
export const REPL_NEW_CONTEXT_NOTICE =
  "\u26a0 This REPL context is new: variables, functions and timers from earlier scripts in this conversation don't exist in it, even those a compaction summary lists as still defined."
export const REPL_TIMEOUT_RESET_NOTE =
  'The previous script was stopped (a timeout or an interrupt), and its context went with it.'

const inputSchema = lazySchema(() =>
  z.strictObject({
    code: z.string().describe('JavaScript code to execute. Supports top-level await. State persists across calls.'),
    description: z
      .string()
      .optional()
      .describe(
        'Clear, concise description of what this script does in active voice (5-10 words). E.g. "Trace upgrade message to its feature flag"',
      ),
    timeout: z
      .number()
      .optional()
      .describe(
        "Optional limit on the script's own running time in milliseconds; time spent inside the tool calls it awaits is not counted (default 30000, max 600000)",
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    code: z.string().describe('The code that was executed'),
    result: z.any().optional().describe('Return value from the code execution'),
    stdout: z.string().describe('What the script logged (self.log; console.log outside REPL mode)'),
    stderr: z.string().describe('Captured console.error output'),
    error: z.string().optional().describe('Error message if execution failed'),
    images: z
      .array(z.object({ base64: z.string(), mediaType: z.string() }))
      .optional()
      .describe('Images returned by inner Read and MCP tool calls — surfaced as image content blocks'),
    imagesOmitted: z
      .number()
      .optional()
      .describe('Count of images from inner tool calls dropped by the per-result image cap; surfaced as a note in the tool_result'),
    documents: z
      .array(z.object({ base64: z.string() }))
      .optional()
      .describe('PDFs returned by inner Read calls — surfaced as document content blocks'),
    documentsOmitted: z
      .number()
      .optional()
      .describe('Count of inner-Read PDFs dropped by the per-result document cap; surfaced as a note in the tool_result'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema> & {
  /** The `<repl-output>` text the model sees, notice included. */
  output?: string
  contextReset?: boolean
  timedOut?: boolean
  interrupted?: boolean
  /** Official `stoppedBy`: the user stopped the script, or declined a call's permission prompt. */
  stoppedBy?: ReplStop['by']
  /** The script's number in the async lane. */
  evalId?: number
  /** The script still runs; its outcome arrives as a `repl-eval` event. */
  asyncDispatched?: boolean
  /** Official: the turn was aborted ("turn-abort") as it dispatched, and the script kept running. */
  keptByTurnAbort?: boolean
}

/** Official replDetachAfterMs (`Z1r()`, 30000 in 2.1.325): when the executor lets the next script start beside a running one. */
export const REPL_DETACH_AFTER_MS = 30_000
export { REPL_ASYNC_WALL_CAP_MS }
/** Official sLo: evals waiting, running or detached on one context (its `depth`) before a dispatch is refused. */
export const REPL_MAX_PENDING_EVALS = 8

const asyncTiming = { detachMs: REPL_DETACH_AFTER_MS, wallCapMs: REPL_ASYNC_WALL_CAP_MS }

export function setReplAsyncTimingForTesting(timing?: Partial<typeof asyncTiming>): void {
  asyncTiming.detachMs = timing?.detachMs ?? REPL_DETACH_AFTER_MS
  asyncTiming.wallCapMs = timing?.wallCapMs ?? REPL_ASYNC_WALL_CAP_MS
}

/**
 * Official `lAt`: a subagent the main thread spawned (not a teammate, not a
 * backgrounded main session, not one a subagent spawned). Such an agent gets
 * the async lane and Poll; any other agent's REPL calls wait for their script.
 */
export function isMainThreadSubagent(context: Pick<ToolUseContext, 'agentId' | 'options'>): boolean {
  const agent = getAgentContext()
  return (
    context.agentId !== undefined &&
    agent?.agentType === 'subagent' &&
    agent.agentId === context.agentId &&
    agent.subagentName !== MAIN_SESSION_SUBAGENT_NAME &&
    getCurrentSubagentDepth(context.options) === 1 &&
    !isInProcessTeammate()
  )
}

/**
 * Official `Xu`: the async lane needs Code Mode, the main thread or a subagent
 * it spawned, Poll in the tool list, and auto or bypassPermissions mode (`oZ`).
 */
export function isReplAsyncLane(context: Pick<ToolUseContext, 'agentId' | 'options'>, mode: PermissionMode): boolean {
  return (
    isCodeModeEnabled() &&
    (context.agentId === undefined || isMainThreadSubagent(context)) &&
    context.options.tools.some(tool => tool.isMcp !== true && toolMatchesName(tool, POLL_TOOL_NAME)) &&
    (mode === 'auto' || mode === 'bypassPermissions')
  )
}

/** Official `gpn`: only a "turn-abort" (a Mods turn abort) leaves dispatched scripts running. */
function keepsDispatched(signal: AbortSignal): boolean {
  return signal.reason === 'turn-abort'
}

/** Official refusal in `Ku` (2.1.325 chunk-g61t94xb.js). */
function pendingCapMessage(depth: number): string {
  return `async REPL dispatch rejected: ${depth} evals already waiting or running \u2014 wait for their settles (Poll) before dispatching more`
}

function withEvalId(output: string, evalId: number | undefined): string {
  return evalId === undefined ? output : output.replace('<repl-output>', `<repl-output eval="${evalId}">`)
}

/** Official: a dispatched script that failed shows as a REPL call of its own (virtual, not sent to the API). */
function failurePair(code: string, description: string | undefined, output: string): Message[] {
  const id = `repl_eval_${randomUUID()}`
  const assistant = createAssistantMessage({
    content: [{ type: 'tool_use', id, name: REPL_TOOL_NAME, input: { code, ...(description ? { description } : {}) } }] as never,
    isVirtual: true,
  })
  const user = createUserMessage({
    content: [{ type: 'tool_result', tool_use_id: id, content: output }],
    isVirtual: true,
    sourceToolAssistantUUID: assistant.uuid,
  })
  return [assistant, user]
}

/** Official `La()`: one line, whitespace collapsed, marked when the text had several. */
function oneLine(text: unknown): string {
  if (typeof text !== 'string') return ''
  const line = text.replace(/\s+/g, ' ').trim()
  if (!line) return ''
  return text.trim().includes('\n') ? `${line} (first line of several)` : line
}

function firstLine(code: string): string {
  return code.split('\n').find(line => line.trim())?.trim() ?? ''
}

/** Auto mode, or plan mode running with auto mode's classifier (official `uo`). */
export function isAutoPermissionMode(mode: PermissionMode): boolean {
  return mode === 'auto' || (mode === 'plan' && isAutoModeActive())
}

/** Modes that can stop at a permission prompt cap the whole script, prompt waits included. */
export function replTotalCapFor(mode: PermissionMode): number | undefined {
  return isAutoPermissionMode(mode) || mode === 'bypassPermissions' ? undefined : REPL_MAX_TIMEOUT_MS
}

function isReplToolUse(name: string, id: string): boolean {
  return name === REPL_TOOL_NAME || name === REPL_ALIAS || id.startsWith('repl_')
}

/** Whether this conversation ran scripts before this call, so a new context lost something. */
function hadEarlierScripts(messages: readonly Message[], toolUseId: string | undefined): boolean {
  for (const message of messages) {
    if (message.type !== 'assistant' || !Array.isArray(message.message.content)) continue
    for (const block of message.message.content) {
      if (block.type === 'tool_use' && block.id !== toolUseId && isReplToolUse(block.name, block.id)) return true
    }
  }
  return false
}

const descriptionCache = new WeakMap<Tool, Promise<string>>()

function toolDescription(tool: Tool, context: ToolUseContext): Promise<string> {
  let cached = descriptionCache.get(tool)
  if (!cached) {
    cached = tool
      .prompt({
        getToolPermissionContext: async () => context.getAppState().toolPermissionContext,
        tools: context.options.tools,
        agents: context.options.agentDefinitions?.activeAgents ?? [],
      })
      .catch(() =>
        tool.description({} as never, {
          isNonInteractiveSession: context.options.isNonInteractiveSession,
          toolPermissionContext: context.getAppState().toolPermissionContext,
          tools: context.options.tools,
        }),
      )
      .catch(() => '')
    descriptionCache.set(tool, cached)
  }
  return cached
}

/** describeTool's answers, computed before the run since the script asks synchronously across the Worker boundary. */
async function describeTools(callable: Tools, context: ToolUseContext): Promise<Map<string, ReplToolDescription>> {
  const entries = await Promise.all(
    callable.map(async tool => [tool.name, { description: await toolDescription(tool, context), inputSchema: toolInputSchema(tool) }] as const),
  )
  return new Map(entries)
}

const SEARCH_DEFAULT_MAX = 5

/** searchTools: callable tools ranked by how many query words their name, hint and description hold. */
export function searchReplTools(
  query: string,
  max: number | undefined,
  callable: Tools,
  descriptions: ReadonlyMap<string, ReplToolDescription>,
): unknown {
  const words = query.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean)
  if (words.length === 0) return { error: 'searchTools needs a query: words from a tool name or description' }
  const limit = Math.max(1, Math.floor(Number.isFinite(max) ? (max as number) : SEARCH_DEFAULT_MAX))
  return callable
    .map(tool => {
      const name = tool.name.toLowerCase()
      const description = descriptions.get(tool.name)?.description ?? ''
      const haystack = `${name} ${tool.searchHint ?? ''} ${description}`.toLowerCase()
      const score = words.reduce((sum, word) => sum + (name.includes(word) ? 3 : 0) + (haystack.includes(word) ? 1 : 0), 0)
      return { tool, score, description }
    })
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ tool, description }) => ({
      name: tool.name,
      about: oneLine(description.split('\n')[0]).slice(0, 200),
      input: schemaToTypeScript(toolInputSchema(tool)),
    }))
}

function resultText(data: Output): string {
  return data.output ?? ''
}

function notices(result: ReplRunResult, fresh: boolean, context: ToolUseContext): string[] {
  if (result.contextReset) return [REPL_NEW_CONTEXT_NOTICE, REPL_TIMEOUT_RESET_NOTE]
  if (fresh && hadEarlierScripts(context.messages, context.toolUseId)) return [REPL_NEW_CONTEXT_NOTICE]
  return []
}

export const REPLTool = buildTool({
  name: REPL_TOOL_NAME,
  aliases: [REPL_ALIAS],
  searchHint: 'execute JavaScript with programmatic tool access',
  maxResultSizeChars: REPL_OUTPUT_TOTAL_CHARS,
  async prompt({ tools, getToolPermissionContext }) {
    // Before the first REPL tool_use is logged, so the transcript keeps the wrapper.
    if (isCodeModeEnabled()) saveCodeMode(true)
    return getReplPrompt(tools, await getToolPermissionContext())
  },
  async description(input) {
    return oneLine(input?.description) || 'Run commands'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return isReplModeEnabled()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  isTransparentWrapper() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.code
  },
  async checkPermissions(input, context) {
    if (isAutoPermissionMode(context.getAppState().toolPermissionContext.mode))
      return { behavior: 'passthrough', message: 'Code Mode script requires classifier review.' }
    return { behavior: 'allow', updatedInput: input }
  },
  userFacingName() {
    return REPL_USER_FACING_NAME
  },
  getToolUseSummary(input) {
    if (!input?.code) return null
    return oneLine(input.description) || firstLine(input.code)
  },
  getActivityDescription(input) {
    const summary = input?.code ? oneLine(input.description) || firstLine(input.code) : ''
    return summary ? `Running ${summary}` : 'Running code'
  },
  renderToolUseMessage,
  async call(input, context, canUseTool, _parentMessage, onProgress) {
    if (isCodeModeEnabled()) saveCodeMode(true)
    const session = getReplSession(context.agentId ?? MAIN_REPL_SESSION)
    const mode = context.getAppState().toolPermissionContext.mode
    const asyncLane = isReplAsyncLane(context, mode)
    const outer = context.abortController.signal
    if (asyncLane && session.depth >= REPL_MAX_PENDING_EVALS) {
      const error = pendingCapMessage(session.depth)
      return {
        data: { code: input.code, stdout: '', stderr: '', error, output: formatReplOutput({ error }), asyncDispatched: true },
        newMessages: takeReplLateMessages(session) as never,
      }
    }
    const fresh = !session.used
    session.used = true
    const evalId = asyncLane ? session.nextEvalId++ : undefined
    // Official `Ku` under `NUe()`: the script is dispatched at once and
    // stays attached when the turn is aborted ("turn-abort").
    const dispatched = asyncLane
    const controller = new AbortController()
    const stop = () => {
      if (dispatched && keepsDispatched(outer)) return
      controller.abort(outer.reason)
    }
    if (outer.aborted) stop()
    else outer.addEventListener('abort', stop, { once: true })
    let hung!: (error: string) => void
    const failure = new Promise<string>(resolve => (hung = resolve))
    const host = createReplToolHost({
      context,
      canUseTool,
      parentToolUseId: context.toolUseId ?? '',
      signal: controller.signal,
      asyncLane,
      codeMode: isCodeModeEnabled(),
      onHung: error => hung(error),
      // The call has returned once dispatched: progress then has no row to go to.
      onProgress: data => {
        if (!dispatched) onProgress?.({ toolUseID: data.toolUseId, data })
      },
    })
    const cleanup = () => {
      host.stop()
      outer.removeEventListener('abort', stop)
    }
    try {
      const callable = getReplCallableTools(context)
      const descriptions = await describeTools(callable, context)
      let startedAt = Date.now()
      let began = false
      let stop: ReplStop | undefined
      if (evalId !== undefined) dispatchReplEval(session, evalId, input.code)
      const running = session.executor.run(input.code, {
        timeoutMs: input.timeout,
        totalCapMs: asyncLane ? asyncTiming.wallCapMs : replTotalCapFor(mode),
        signal: controller.signal,
        tools: host.tools.map(({ name, scriptName, aliases }: ReplToolDescriptor) => ({ name, scriptName, aliases })),
        callTool: (name, toolInput) => host.call(name, toolInput),
        describeTool: name => descriptions.get(name),
        searchTools: (query, max) => searchReplTools(query, max, callable, descriptions),
        prelude: REPL_HELPERS_PRELUDE,
        totalCapError: ms => host.wallClockError(ms),
        failure,
        onScriptEnd: failed => host.scriptEnded(failed),
        ...(isCodeModeEnabled() && { errorNote: (stopped: boolean) => partwayNote(host.calls(), stopped) }),
        // Official `qu`: only a call the executor waits on reports the stop,
        // listing the calls as they stood when it came.
        interruptedError: () => {
          if (context.stoppedResultWait === undefined) return undefined
          stop = replStopOf(controller.signal.reason, host.calls())
          return stop && replStopReport(stop)
        },
        ...(asyncLane && {
          detachAfterMs: asyncTiming.detachMs,
          evalId,
          onDetach: () => detachReplEval(session, evalId!),
          onStart: () => {
            began = true
            startedAt = Date.now()
            startReplEval(session, evalId!)
          },
        }),
      })
      if (evalId !== undefined) {
        const finish = () => finishReplEval(session, evalId)
        void running.then(finish, finish)
        session.pending.set(evalId, { id: evalId, startedAt, abort: reason => controller.abort(reason) })
        // Official: the main thread's eval the user stopped does not start a turn of its own.
        // INFERRED: an Esc interrupt cancelling a waiting eval is a user stop too.
        const startsTurn = () =>
          context.agentId === undefined &&
          controller.signal.aborted &&
          (isUserStop(controller.signal.reason) || controller.signal.reason === 'interrupt')
            ? { startsTurn: false as const }
            : {}
        void running.then(
          late => {
            cleanup()
            if (!began && late.interrupted) {
              // INFERRED: the registry rejects a cancelled waiting eval, so its outcome takes `tr`'s failure form.
              const text = replCancelledBeforeStartText(controller.signal.reason, outer.aborted && !keepsDispatched(outer))
              const event = { id: evalId, text: formatReplEvalEvent(evalId, 0, text, new Date(), 'failed'), ...startsTurn() }
              deliverReplEvent(session, event, host.drainMessages())
              session.pending.delete(evalId)
              return
            }
            const output = withEvalId(late.output, evalId)
            const messages = [
              ...host.drainMessages(),
              ...(late.error === undefined ? [] : failurePair(input.code, input.description, output)),
            ]
            const event = { id: evalId, text: formatReplEvalEvent(evalId, Date.now() - startedAt, late.output), ...startsTurn() }
            deliverReplEvent(session, event, messages)
            session.pending.delete(evalId)
          },
          (error: unknown) => {
            // Official `tr` with its failure flag: the host failed before the script settled.
            cleanup()
            const text =
              error instanceof Error
                ? error.message
                : 'host-side failure before settling (non-Error rejection; detail withheld from coercion)'
            const event = { id: evalId, text: formatReplEvalEvent(evalId, Date.now() - startedAt, text, new Date(), 'failed'), ...startsTurn() }
            deliverReplEvent(session, event, host.drainMessages())
            session.pending.delete(evalId)
          },
        )
        const receipt = `(dispatched #${evalId})`
        const output = [...(fresh && hadEarlierScripts(context.messages, context.toolUseId) ? [REPL_NEW_CONTEXT_NOTICE] : []), receipt].join('\n')
        const data: Output = {
          code: input.code,
          result: receipt,
          stdout: '',
          stderr: '',
          output,
          evalId,
          asyncDispatched: true,
          ...(keepsDispatched(outer) && outer.aborted ? { keptByTurnAbort: true } : {}),
        }
        return { data, newMessages: [...takeReplLateMessages(session), ...host.drainMessages()] as never }
      }
      const done = await running
      const output = [...notices(done, fresh, context), done.output].join('\n')
      const data: Output = {
        code: input.code,
        ...(done.value === undefined ? {} : { result: done.value }),
        stdout: done.stdout ?? '',
        stderr: done.stderr ?? '',
        ...(done.error === undefined ? {} : { error: done.error }),
        output,
        ...(done.contextReset ? { contextReset: true } : {}),
        ...(done.timedOut ? { timedOut: true } : {}),
        ...(done.interrupted ? { interrupted: true } : {}),
        ...(done.interrupted && stop ? { stoppedBy: stop.by } : {}),
        // Official: only a script that settled without an error carries its calls' images and PDFs.
        ...(done.error === undefined ? collectResultBlocks(host.calls()) : {}),
      }
      return { data, newMessages: [...takeReplLateMessages(session), ...host.drainMessages()] as never }
    } finally {
      if (!dispatched) cleanup()
    }
  },
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      // Never is_error: an error is part of the <repl-output>, which resume inference reads from non-error results.
      content: resultBlockContent(resultText(data), data) ?? resultText(data),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
