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
import { isPowerShellToolEnabled } from '../../utils/shell/shellToolUtils.js'
import { getMaxBashTimeoutMs } from '../../utils/timeouts.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { POWERSHELL_TOOL_NAME } from '../PowerShellTool/toolName.js'
import { filterToolsByDenyRules } from '../../tools.js'
import { POLL_TOOL_NAME, REPL_ASYNC_WALL_CAP_MS, REPL_TOOL_NAME, SCRIPT_ASK_DECLINED } from './constants.js'
import { elide } from './executor/host.js'
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
}): ReplToolHost {
  const { context, canUseTool, signal, asyncLane, codeMode, onProgress } = opts
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
  let stopped = false
  let afterStop = 0
  let noMoreCalls = false
  const callSettled = new Set<() => void>()

  /** Official `Xe`: a refused built-in call resolves {error}; an MCP call throws. */
  function refusal(tool: Tool, text: string): { error: string } {
    if (tool.isMcp) throw new McpToolError(text, undefined)
    return { error: text }
  }

  async function run(
    tool: Tool,
    input: unknown,
    toolUseId: string,
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
    const parents = new Set([signal, context.abortController.signal])
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
      for await (const update of runToolUse(block, assistant, canUseTool, {
        ...context,
        innerCall: true,
        replScriptCall: true,
        ...(asyncLane && { shellWallCapMs: REPL_ASYNC_WALL_CAP_MS }),
        preserveToolUseResults: true,
        modToolCallResult: undefined,
        fileReadingLimits: READ_LIMITS,
        globLimits: GLOB_LIMITS,
        options: { ...context.options, tools: refreshTools(), refreshTools },
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
            ...(isError && { is_error: true }),
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
      if (callCount >= REPL_MAX_TOOL_CALLS)
        throw new Error(`The REPL script reached the limit of ${REPL_MAX_TOOL_CALLS} tool calls`)
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
      await slots.acquire()
      try {
        if (noMoreCalls) {
          record.error = REPL_CALL_NOT_STARTED
          progress('error')
          return refusal(tool, REPL_CALL_NOT_STARTED)
        }
        progress('executing')
        const { value, raw, mcpContent, isError, declined } = await run(
          tool,
          asyncLane ? withAsyncShellTimeout(tool, input) : input,
          toolUseId,
        )
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
        slots.release()
        for (const notify of [...callSettled]) notify()
      }
    },
  }
}
