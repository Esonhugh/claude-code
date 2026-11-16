import { randomUUID } from 'node:crypto'
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import {
  toolMatchesName,
  type Tool,
  type ToolPermissionContext,
  type ToolUseContext,
  type Tools,
} from '../../Tool.js'
import type { Message, UserMessage } from '../../types/message.js'
import type { REPLToolCallProgress } from '../../types/tools.js'
import { createAbortController } from '../../utils/abortController.js'
import { AbortError } from '../../utils/errors.js'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
import { parsePDFPageRange } from '../../utils/pdfUtils.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { formatDuration } from '../../utils/format.js'
import { isPowerShellToolEnabled } from '../../utils/shell/shellToolUtils.js'
import { getDefaultBashTimeoutMs, getMaxBashTimeoutMs } from '../../utils/timeouts.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { GLOB_TOOL_NAME } from '../GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../GrepTool/prompt.js'
import { POWERSHELL_TOOL_NAME } from '../PowerShellTool/toolName.js'
import { filterToolsByDenyRules } from '../../tools.js'
import { POLL_TOOL_NAME, REPL_ASYNC_WALL_CAP_MS, REPL_TOOL_NAME, SCRIPT_ASK_DECLINED } from './constants.js'
import { elide, REPL_MAX_TIMEOUT_MS } from './executor/host.js'
import { getReplPrimitiveTools } from './primitiveTools.js'
import { type ReplImage, scriptValue } from './resultBlocks.js'
import type { ReplCallRecord } from './stopReport.js'

/** Calls one script may make, as in official 2.1.325 (`Hjs`). */
export const REPL_MAX_TOOL_CALLS = 50_000
/** Calls still let through after the script was stopped (`I0o`). */
export const REPL_CALLS_AFTER_STOP = 20
const REPL_MAX_CONCURRENCY = 10
const READ_LIMITS = { maxTokens: Infinity, maxSizeBytes: 268_435_456 }
const GLOB_LIMITS = { maxResults: 25_000 }

export type ReplToolDescriptor = {
  name: string
  scriptName: string
  aliases: string[]
  isMcp: boolean
  mcpServer?: string
}

export type ReplToolHost = {
  tools: readonly ReplToolDescriptor[]
  call(name: string, input: unknown): Promise<unknown>
  drainMessages(): Message[]
  stop(): void
  /** Official `ju`: the error for a script stopped at its wall-clock limit of `ms`. */
  wallClockError(ms: number): string
  /** The script returned or threw: lines its stderr gets about calls it did not await. */
  scriptEnded(failed: boolean): Promise<string[]>
  readonly callCount: number
  /** Copies of the calls the script started, in order (official `Zu` input). */
  calls(): ReplCallRecord[]
}

/** Official `ss`: a call made after its script ended. */
const REPL_CALL_AFTER_SCRIPT_END =
  "This tool call did not run. The piece of code that it belongs to had already finished, and a timer or promise that finished code leaves running can't make tool calls. To run these steps, send them again in one piece of code that awaits each of them."
/** Official `Ln`: a call still waiting for a slot when its script ended. */
const REPL_CALL_NOT_STARTED =
  'This tool call did not run. The code that made it finished or was stopped before the call could start. If it is still needed and nobody stopped the code, make the call again in code that awaits it.'

function toolList(calls: readonly ReplCallRecord[]): string {
  const counts = new Map<string, number>()
  for (const call of calls) counts.set(call.toolName, (counts.get(call.toolName) ?? 0) + 1)
  return [...counts].map(([name, n]) => (n > 1 ? `${name} \u00d7${n}` : name)).join(', ')
}

/**
 * Official `Da`: Code Mode's sync lane waits at script end for the calls that
 * were running and starts none of the queued ones, then says what became of them.
 */
function leftoverCallLines(left: readonly ReplCallRecord[], running: readonly ReplCallRecord[], scriptFailed: boolean): string[] {
  // A call refused at its slot ends as an error; a failed script reports only the ones still queued.
  const notStarted = left.filter(call => (scriptFailed ? call.phase === 'start' : call.phase !== 'complete'))
  const failed = running.filter(call => call.phase === 'error')
  const ran = running.filter(call => call.phase !== 'error')
  return [
    ...(notStarted.length > 0
      ? [`\u26a0 ${notStarted.length} tool call(s) had not started when the script ended, and did not run: ${toolList(notStarted)}. Add 'await'.`]
      : []),
    ...(ran.length > 0
      ? [`\u26a0 ${ran.length} tool call(s) were still running when the script ended. They ran to their end, but the script ended before their results came: ${toolList(ran)}. Do not make them again. Add 'await' next time.`]
      : []),
    ...failed.map(
      call => `\u26a0 ${call.toolName} was still running when the script ended, and then failed. Add 'await' next time. Its error:\n${elide(call.error ?? '', 2000)}`,
    ),
  ]
}

/** Official `kr`: up to three tool names, then "other". */
function toolNames(calls: readonly { toolName: string }[]): string {
  const unique = [...new Set(calls.map(call => call.toolName))]
  const names = unique.length > 3 ? [...unique.slice(0, 3), 'other'] : unique
  return names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/**
 * Official `ju`/`Fu`: which wall-clock text fits depends on whether calls were
 * still waiting to run (perhaps at a permission prompt) and on what was running.
 */
function wallClockText(
  ms: number,
  waiting: readonly ReplCallRecord[],
  executing: readonly ReplCallRecord[],
  sync: boolean,
): string {
  const limit = formatDuration(ms, { hideTrailingZeros: true })
  if (waiting.length > 0) {
    const one = waiting.length === 1
    const tail =
      executing.length > 0
        ? ' Another call was still running and may be hung \u2014 try a shorter timeout on the tool itself, or split the work.'
        : ` Otherwise ${one ? 'it' : 'one of them'} may be hung in a hook or in a check of its directories.`
    return `REPL execution exceeded its wall-clock limit of ${limit} while its ${toolNames(waiting)} ${one ? 'call was' : 'calls were'} waiting to run. ${one ? 'It' : 'They'} may have been waiting for the user to answer a permission prompt, which is now closed. If so, running ${one ? 'it' : 'them'} again will ask the user again.${tail}`
  }
  const shellCall =
    sync &&
    executing.length > 0 &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS) &&
    executing.every(call => call.toolName === BASH_TOOL_NAME || call.toolName === POWERSHELL_TOOL_NAME)
  if (shellCall)
    return `REPL execution exceeded its wall-clock limit of ${limit} before a shell call finished. The limit is on the whole script, and a command still running when it is reached is stopped with the script. A command whose own timeout ends before the limit moves to the background at that timeout and keeps running (one that starts with sleep is stopped instead), so give a long command a shorter timeout, or split the work.`
  return `REPL execution exceeded hard wall-clock limit of ${ms}ms. An inner tool call may be hung \u2014 try a shorter timeout on the tool itself, or split the work.`
}

/** Official `ls`: built-ins whose calls have a 10 s timeout of their own. */
const SHORT_TIMEOUT_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'NotebookEdit',
  'TodoWrite',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskStop',
  'TaskUpdate',
])

/** Official `hr`: the timeout a call has of its own, if any. */
function nativeTimeoutMs(tool: Tool, input: unknown, asyncLane: boolean, codeMode: boolean): number | undefined {
  if (tool.name === BASH_TOOL_NAME || tool.name === POWERSHELL_TOOL_NAME) {
    const own = (input as { timeout?: unknown } | null)?.timeout
    const timeout = typeof own === 'number' && own > 0 ? own : undefined
    return asyncLane
      ? Math.min(timeout ?? getMaxBashTimeoutMs(), REPL_ASYNC_WALL_CAP_MS)
      : Math.min(timeout ?? getDefaultBashTimeoutMs(), getMaxBashTimeoutMs())
  }
  if (codeMode && (tool.name === GREP_TOOL_NAME || tool.name === GLOB_TOOL_NAME)) return undefined
  return SHORT_TIMEOUT_TOOLS.has(tool.name) ? 10_000 : undefined
}

/** Official `dc`: a call is taken as hung at 1.5 times its own timeout plus 5 s, unless that passes the script cap. */
function watchdogMs(native: number | undefined): number | undefined {
  if (native === undefined) return undefined
  const ms = Math.ceil(native * 1.5) + 5000
  return ms >= REPL_MAX_TIMEOUT_MS ? undefined : ms
}

/** An MCP tool reported an error; `detail` is its text parsed as JSON when possible. */
export class McpToolError extends Error {
  detail: unknown
  constructor(message: string, detail: unknown) {
    super(message)
    this.name = 'McpToolError'
    this.detail = detail
  }
}

/** A name usable as a JavaScript identifier inside the script. */
export function toScriptName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_$]/g, '_')
  return /^[0-9]/.test(safe) ? `_${safe}` : safe
}

/** The REPL-callable set for a tool pool, also used for the prompt's declarations. */
export function replCallableToolsFrom(
  tools: Tools,
  permissionContext: ToolPermissionContext,
  grant?: ReadonlySet<string>,
): Tools {
  const seen = new Set<string>()
  const result: Tool[] = []
  // The grant narrows only the added primitives; the session's own tools
  // already went through the agent's tool resolution (official On()).
  const primitives = grant === undefined
    ? getReplPrimitiveTools()
    : getReplPrimitiveTools().filter(tool => grant.has(tool.name))
  for (const tool of [...tools, ...primitives]) {
    // Poll waits on scripts, so one called from a script would wait on itself.
    if (seen.has(tool.name) || toolMatchesName(tool, REPL_TOOL_NAME) || tool.name === POLL_TOOL_NAME) continue
    seen.add(tool.name)
    if (tool.name === POWERSHELL_TOOL_NAME && !isPowerShellToolEnabled()) continue
    result.push(tool)
  }
  // Also drops apply_patch when Edit or Write is denied.
  return filterToolsByDenyRules(result, permissionContext)
}

/** Tools a REPL script may call: the session's tools without REPL, plus the primitives. */
export function getReplCallableTools(context: ToolUseContext): Tools {
  return replCallableToolsFrom(
    context.options.tools,
    context.getAppState().toolPermissionContext,
    context.primitiveToolGrant,
  )
}

function resultText(block: ToolResultBlockParam): string {
  const content = block.content
  if (typeof content === 'string') return content
  if (!content) return ''
  return content.map(part => (part.type === 'text' ? part.text : '')).join('')
}

function errorText(text: string): string {
  return text.replace(/^<tool_use_error>([\s\S]*)<\/tool_use_error>$/, '$1')
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function mcpValue(block: ToolResultBlockParam): unknown {
  const content = block.content
  if (Array.isArray(content) && content.some(part => part.type !== 'text')) return content
  return parseJson(resultText(block))
}

function imagesOf(content: readonly unknown[]): ReplImage[] {
  const images: ReplImage[] = []
  for (const block of content) {
    const source = (block as { type?: unknown; source?: Record<string, unknown> }).source
    if ((block as { type?: unknown }).type === 'image' && source?.type === 'base64' && typeof source.data === 'string')
      images.push({ base64: source.data, mediaType: String(source.media_type) })
  }
  return images
}

/** Official Read's paged result holds its pages (`firstPage`, `pages`); this Read sends them as a meta message. */
function withPages(tool: Tool, input: unknown, data: unknown, pages: ReplImage[]): unknown {
  if (tool.name !== FILE_READ_TOOL_NAME || pages.length === 0) return data
  if ((data as { type?: unknown } | null)?.type !== 'parts' || 'pages' in (data as object)) return data
  const range = (input as { pages?: unknown } | null)?.pages
  const firstPage = typeof range === 'string' ? parsePDFPageRange(range)?.firstPage : undefined
  return { ...(data as object), ...(firstPage !== undefined && { firstPage }), pages }
}

function createSemaphore(limit: number) {
  let active = 0
  const waiting: (() => void)[] = []
  return {
    async acquire(): Promise<void> {
      if (active < limit) {
        active++
        return
      }
      await new Promise<void>(resolve => waiting.push(resolve))
    },
    release(): void {
      const next = waiting.shift()
      if (next) next()
      else active--
    },
  }
}

/**
 * Official `shellWallCapMs`: in the async lane a shell command with no
 * timeout of its own is awaited for up to the shell's max timeout, and its
 * own timeout may go up to the async wall cap instead of the shell's max.
 */
function withAsyncShellTimeout(tool: Tool, input: unknown): unknown {
  if (tool.name !== BASH_TOOL_NAME && tool.name !== POWERSHELL_TOOL_NAME) return input
  if (input === null || typeof input !== 'object') return input
  const own = (input as { timeout?: unknown }).timeout
  const timeout = typeof own === 'number' && own > 0 ? own : getMaxBashTimeoutMs()
  return { ...input, timeout: Math.min(timeout, REPL_ASYNC_WALL_CAP_MS) }
}

/**
 * Script-side tool calls for one REPL invocation. Each call runs the same
 * runToolUse pipeline as a model tool call (schema, validateInput, PreToolUse,
 * permission, tool.call, PostToolUse, Mods tool.call hooks) and hands the
 * value back to the script instead of the model.
 */
export function createReplToolHost(opts: {
  context: ToolUseContext
  canUseTool: CanUseToolFn
  parentToolUseId: string
  signal: AbortSignal
  asyncLane?: boolean
  /** Code Mode's sync lane ends a script as official `Ze` does. */
  codeMode?: boolean
  onProgress?: (p: REPLToolCallProgress) => void
  /** Official watchdog: a call ran far past its own timeout; the script is to end with this error. */
  onHung?: (error: string) => void
}): ReplToolHost {
  const { context, canUseTool, signal, asyncLane, codeMode, onProgress, onHung } = opts
  const callable = getReplCallableTools(context)
  const byName = new Map<string, Tool>()
  const tools: ReplToolDescriptor[] = []
  for (const tool of callable) {
    const scriptName = toScriptName(tool.name)
    for (const name of [tool.name, scriptName, ...(tool.aliases ?? [])])
      if (!byName.has(name)) byName.set(name, tool)
    tools.push({
      name: tool.name,
      scriptName,
      aliases: [...(tool.aliases ?? [])],
      isMcp: tool.isMcp === true,
      ...(tool.mcpInfo && { mcpServer: tool.mcpInfo.serverName }),
    })
  }
  const configured = Number(process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY)
  const slots = createSemaphore(
    Math.min(configured > 0 ? configured : REPL_MAX_CONCURRENCY, REPL_MAX_CONCURRENCY),
  )
  const refreshTools = () =>
    replCallableToolsFrom(
      context.options.refreshTools?.() ?? context.options.tools,
      context.getAppState().toolPermissionContext,
      context.primitiveToolGrant,
    )
  let messages: Message[] = []
  const started: ReplCallRecord[] = []
  let callCount = 0
  let callCapRefused = false
  let stopped = false
  let afterStop = 0
  let noMoreCalls = false
  const callSettled = new Set<() => void>()
  // Official phase `executing` starts at tool.call, after hooks and the permission prompt.
  const inTool = new Set<ReplCallRecord>()
  // Official `D.abort()`: a hung call stops every call of the script.
  const hungStop = createAbortController()

  /** Official `Xe`: a refused built-in call resolves {error}; an MCP call throws. */
  function refusal(tool: Tool, text: string): { error: string } {
    if (tool.isMcp) throw new McpToolError(text, undefined)
    return { error: text }
  }

  async function run(
    tool: Tool,
    input: unknown,
    toolUseId: string,
    onToolCall: () => void,
  ): Promise<{ value: unknown; raw: unknown; mcpContent?: boolean; isError: boolean; declined?: { reason: unknown } }> {
    const block = {
      type: 'tool_use' as const,
      caller: { type: 'direct' as const },
      id: toolUseId,
      name: tool.name,
      input: input as Record<string, unknown>,
    }
    const assistant = createAssistantMessage({ content: [block], isVirtual: true })
    const abortController = createAbortController()
    const parents = new Set([signal, context.abortController.signal, hungStop.signal])
    const abort = () => {
      const parent = [...parents].find(parent => parent.aborted)
      if (parent) abortController.abort(parent.reason)
    }
    for (const parent of parents) parent.addEventListener('abort', abort, { once: true })
    abort()
    // Official `v.pending`: the call's own controller aborted while it ran and
    // its parents had not, which is how a declined permission prompt shows.
    let declined: { reason: unknown } | undefined
    let settled = false
    abortController.signal.addEventListener(
      'abort',
      () => {
        if (!settled && ![...parents].some(parent => parent.aborted))
          declined = { reason: abortController.signal.reason }
      },
      { once: true },
    )
    try {
      if (abortController.signal.aborted) throw new AbortError()
      const { runToolUse } = await import('../../services/tools/toolExecution.js')
      let reply: UserMessage | undefined
      let result: ToolResultBlockParam | undefined
      // A paged Read sends its page images in a meta message after its result.
      const pageImages: ReplImage[] = []
      // The tool itself still gets the caller's canUseTool.
      const marked = (list: Tools): Tools =>
        list.map(candidate =>
          candidate.name === tool.name
            ? ({
                ...candidate,
                call: (...args: Parameters<Tool['call']>) => {
                  onToolCall()
                  return candidate.call(...args)
                },
              } as Tool)
            : candidate,
        )
      const markedTools = () => marked(refreshTools())
      for await (const update of runToolUse(block, assistant, canUseTool, {
        ...context,
        // Official script calls have no tool JSX (Bash's background hint is a progress hint there);
        // ours would outlive a dispatched script's turn and keep Esc from stopping it.
        setToolJSX: undefined,
        innerCall: true,
        replScriptCall: true,
        ...(asyncLane && { shellWallCapMs: REPL_ASYNC_WALL_CAP_MS }),
        preserveToolUseResults: true,
        modToolCallResult: undefined,
        fileReadingLimits: READ_LIMITS,
        globLimits: GLOB_LIMITS,
        options: { ...context.options, tools: markedTools(), refreshTools: markedTools },
        abortController,
      })) {
        // Progress and hook attachments stay inside the script call.
        const message = update.message
        if (message?.type !== 'user' || !Array.isArray(message.message.content)) continue
        if (message.isMeta && tool.name === FILE_READ_TOOL_NAME) pageImages.push(...imagesOf(message.message.content))
        for (const part of message.message.content)
          if (part.type === 'tool_result' && part.tool_use_id === toolUseId) {
            reply = message
            result = part as ToolResultBlockParam
          }
      }
      if (abortController.signal.aborted && !declined) throw new AbortError()
      if (!reply || !result) throw new Error(`${tool.name} returned no result`)
      const isError = result.is_error === true
      const text = isError ? errorText(resultText(result)) : ''
      const denied = isError && reply.permissionDecision?.decision === 'reject'
      const error = denied ? `Permission denied for ${tool.name}: ${text}` : text
      const raw = isError
        ? { error }
        : tool.isMcp
          ? mcpValue(result)
          : reply.toolUseResult !== undefined
            ? withPages(tool, input, reply.toolUseResult, pageImages)
            : resultText(result)
      const mcpContent = tool.isMcp === true && Array.isArray(raw)
      const value = scriptValue({ toolName: tool.name, mcpContent }, raw)
      messages.push(
        assistant,
        createUserMessage({
          content: [{
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: isError ? error : '',
            is_error: isError,
          }],
          isVirtual: true,
          toolUseResult: value,
          ...(reply.toolDenialKind && { toolDenialKind: reply.toolDenialKind }),
          ...(reply.permissionDecision && { permissionDecision: reply.permissionDecision }),
          sourceToolAssistantUUID: assistant.uuid,
        }),
      )
      if (isError && tool.isMcp && !declined) throw new McpToolError(error, parseJson(text))
      return { value, raw, ...(mcpContent && { mcpContent }), isError, ...(declined && { declined }) }
    } finally {
      settled = true
      for (const parent of parents) parent.removeEventListener('abort', abort)
    }
  }

  return {
    tools,
    get callCount() {
      return callCount
    },
    stop() {
      stopped = true
    },
    wallClockError(ms) {
      const waiting = started.filter(call => call.phase === 'start' || (call.phase === 'executing' && !inTool.has(call)))
      const executing = started.filter(call => call.phase === 'executing' && inTool.has(call))
      return wallClockText(ms, waiting, executing, !asyncLane)
    },
    async scriptEnded(failed) {
      const left = started.filter(call => call.phase === 'start' || call.phase === 'executing')
      if (asyncLane) {
        return failed || left.length === 0
          ? []
          : [`\u26a0 ${left.length} tool call(s) still running at script end (${left.map(call => call.toolName).join(', ')}) \u2014 they run on and their effects happen; what a .then(self.log) logs arrives as late output, anything else is not in this result. Do not re-issue them; await next time.`]
      }
      if (!codeMode) {
        return failed || left.length === 0
          ? []
          : [`\u26a0 ${left.length} tool call(s) still pending at script end \u2014 results discarded: ${left.map(call => call.toolName).join(', ')}. Add 'await'.`]
      }
      noMoreCalls = true
      const queued = left.filter(call => call.phase === 'start')
      const running = left.filter(call => call.phase === 'executing')
      while (running.some(call => call.phase === 'executing') && !signal.aborted) {
        await new Promise<void>(resolve => {
          const done = () => {
            callSettled.delete(done)
            signal.removeEventListener('abort', done)
            resolve()
          }
          callSettled.add(done)
          signal.addEventListener('abort', done, { once: true })
        })
      }
      return leftoverCallLines(queued, running, failed)
    },
    calls() {
      return started.map(call => ({ ...call }))
    },
    drainMessages() {
      const drained = messages
      messages = []
      return drained
    },
    async call(name, input) {
      const tool = byName.get(name)
      if (!tool) throw new Error(`${name} is not available in this REPL call`)
      if (stopped && ++afterStop > REPL_CALLS_AFTER_STOP)
        throw new Error('The REPL script was stopped; no further tool calls are made')
      if (noMoreCalls) return refusal(tool, REPL_CALL_AFTER_SCRIPT_END)
      if (callCount >= REPL_MAX_TOOL_CALLS) {
        // Official: only the first call past the cap hears why; later ones are left unanswered.
        if (callCapRefused) return new Promise<never>(() => {})
        callCapRefused = true
        throw new Error(
          `${name}: this script has made ${REPL_MAX_TOOL_CALLS.toLocaleString('en-US')} calls, its cap. The call was not made, and no later call of this script will be answered.`,
        )
      }
      callCount++
      if (
        asyncLane &&
        (tool.name === BASH_TOOL_NAME || tool.name === POWERSHELL_TOOL_NAME) &&
        (input as { run_in_background?: unknown } | null)?.run_in_background === true
      )
        return {
          error: `${tool.name}: run_in_background is not available in the async REPL. The eval already runs in the background, so await the command instead.`,
        }
      const toolUseId = `repl_${randomUUID()}`
      const record: ReplCallRecord = { toolName: tool.name, toolInput: input, phase: 'start' }
      started.push(record)
      const progress = (phase: REPLToolCallProgress['phase']) => {
        record.phase = phase
        onProgress?.({ type: 'repl_tool_call', phase, toolName: tool.name, toolUseId })
      }
      progress('start')
      let watchdog: ReturnType<typeof setTimeout> | undefined
      await slots.acquire()
      try {
        if (noMoreCalls) {
          record.error = REPL_CALL_NOT_STARTED
          progress('error')
          return refusal(tool, REPL_CALL_NOT_STARTED)
        }
        progress('executing')
        const callInput = asyncLane ? withAsyncShellTimeout(tool, input) : input
        const native = nativeTimeoutMs(tool, callInput, asyncLane === true, codeMode === true)
        const limit = watchdogMs(native)
        const arm = () => {
          clearTimeout(watchdog)
          inTool.add(record)
          if (limit === undefined) return
          watchdog = setTimeout(() => {
            onHung?.(
              `REPL inner tool call ${tool.name} exceeded ${limit}ms watchdog (native timeout ${native ?? 'unset'}). The call may be hung \u2014 try a shorter timeout on the tool itself.`,
            )
            hungStop.abort()
          }, limit)
        }
        const { value, raw, mcpContent, isError, declined } = await run(tool, callInput, toolUseId, arm)
        if (isError) record.error = (value as { error: string }).error
        else record.value = raw
        if (mcpContent) record.mcpContent = true
        if (declined) record.declined = true
        progress(isError || declined ? 'error' : 'complete')
        // Official `onStopTurn`: a decline stops the turn, and with it the script,
        // once the call has its result; the async lane marks the stop as one.
        if (declined) context.abortController.abort(asyncLane ? SCRIPT_ASK_DECLINED : declined.reason)
        return value
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error)
        progress('error')
        throw error
      } finally {
        clearTimeout(watchdog)
        inTool.delete(record)
        slots.release()
        for (const notify of [...callSettled]) notify()
      }
    },
  }
}
