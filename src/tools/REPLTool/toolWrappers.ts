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
import { isPowerShellToolEnabled } from '../../utils/shell/shellToolUtils.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'
import { POWERSHELL_TOOL_NAME } from '../PowerShellTool/toolName.js'
import { filterToolsByDenyRules } from '../../tools.js'
import { REPL_TOOL_NAME } from './constants.js'
import { getReplPrimitiveTools } from './primitiveTools.js'

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
  readonly callCount: number
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
    if (seen.has(tool.name) || toolMatchesName(tool, REPL_TOOL_NAME)) continue
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
  onProgress?: (p: REPLToolCallProgress) => void
}): ReplToolHost {
  const { context, canUseTool, signal, asyncLane, onProgress } = opts
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
  let callCount = 0
  let stopped = false
  let afterStop = 0

  async function run(
    tool: Tool,
    input: unknown,
    toolUseId: string,
  ): Promise<{ value: unknown; isError: boolean }> {
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
    try {
      if (abortController.signal.aborted) throw new AbortError()
      const { runToolUse } = await import('../../services/tools/toolExecution.js')
      let reply: UserMessage | undefined
      let result: ToolResultBlockParam | undefined
      for await (const update of runToolUse(block, assistant, canUseTool, {
        ...context,
        innerCall: true,
        replScriptCall: true,
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
        for (const part of message.message.content)
          if (part.type === 'tool_result' && part.tool_use_id === toolUseId) {
            reply = message
            result = part as ToolResultBlockParam
          }
      }
      if (abortController.signal.aborted) throw new AbortError()
      if (!reply || !result) throw new Error(`${tool.name} returned no result`)
      const isError = result.is_error === true
      const text = isError ? errorText(resultText(result)) : ''
      const denied = isError && reply.permissionDecision?.decision === 'reject'
      const error = denied ? `Permission denied for ${tool.name}: ${text}` : text
      const value = isError
        ? { error }
        : tool.isMcp
          ? mcpValue(result)
          : reply.toolUseResult !== undefined
            ? reply.toolUseResult
            : resultText(result)
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
      if (isError && tool.isMcp) throw new McpToolError(error, parseJson(text))
      return { value, isError }
    } finally {
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
      const progress = (phase: REPLToolCallProgress['phase']) =>
        onProgress?.({ type: 'repl_tool_call', phase, toolName: tool.name, toolUseId })
      progress('start')
      await slots.acquire()
      try {
        progress('executing')
        const { value, isError } = await run(tool, input, toolUseId)
        progress(isError ? 'error' : 'complete')
        return value
      } catch (error) {
        progress('error')
        throw error
      } finally {
        slots.release()
      }
    },
  }
}
