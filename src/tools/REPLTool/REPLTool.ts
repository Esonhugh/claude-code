import { z } from 'zod/v4'
import { buildTool, type Tool, type ToolDef, type ToolUseContext, type Tools } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { isAutoModeActive } from '../../utils/permissions/autoModeState.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import { saveCodeMode } from '../../utils/sessionStorage.js'
import { isCodeModeEnabled } from './codeModeGate.js'
import { isReplModeEnabled, REPL_TOOL_NAME } from './constants.js'
import {
  REPL_MAX_TIMEOUT_MS,
  REPL_OUTPUT_TOTAL_CHARS,
  type ReplRunResult,
  type ReplToolDescription,
} from './executor/host.js'
import { REPL_HELPERS_PRELUDE } from './helpers.js'
import { getReplPrompt, schemaToTypeScript, toolInputSchema } from './prompt.js'
import { getReplSession, MAIN_REPL_SESSION } from './sessions.js'
import { createReplToolHost, getReplCallableTools, type ReplToolDescriptor } from './toolWrappers.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

export const REPL_ALIAS = 'Eval'
export const REPL_USER_FACING_NAME = 'Code'

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
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema> & {
  /** The `<repl-output>` text the model sees, notice included. */
  output?: string
  contextReset?: boolean
  timedOut?: boolean
  interrupted?: boolean
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
  renderToolResultMessage,
  async call(input, context, canUseTool, _parentMessage, onProgress) {
    if (isCodeModeEnabled()) saveCodeMode(true)
    const session = getReplSession(context.agentId ?? MAIN_REPL_SESSION)
    const fresh = !session.used
    session.used = true
    const controller = new AbortController()
    const stop = () => controller.abort()
    const outer = context.abortController.signal
    if (outer.aborted) controller.abort()
    else outer.addEventListener('abort', stop, { once: true })
    const host = createReplToolHost({
      context,
      canUseTool,
      parentToolUseId: context.toolUseId ?? '',
      signal: controller.signal,
      onProgress: data => onProgress?.({ toolUseID: data.toolUseId, data }),
    })
    try {
      const callable = getReplCallableTools(context)
      const descriptions = await describeTools(callable, context)
      const result = await session.executor.run(input.code, {
        timeoutMs: input.timeout,
        totalCapMs: replTotalCapFor(context.getAppState().toolPermissionContext.mode),
        signal: controller.signal,
        tools: host.tools.map(({ name, scriptName, aliases }: ReplToolDescriptor) => ({ name, scriptName, aliases })),
        callTool: (name, toolInput) => host.call(name, toolInput),
        describeTool: name => descriptions.get(name),
        searchTools: (query, max) => searchReplTools(query, max, callable, descriptions),
        prelude: REPL_HELPERS_PRELUDE,
      })
      const output = [...notices(result, fresh, context), result.output].join('\n')
      const data: Output = {
        code: input.code,
        ...(result.value === undefined ? {} : { result: result.value }),
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        ...(result.error === undefined ? {} : { error: result.error }),
        output,
        ...(result.contextReset ? { contextReset: true } : {}),
        ...(result.timedOut ? { timedOut: true } : {}),
        ...(result.interrupted ? { interrupted: true } : {}),
      }
      return { data, newMessages: host.drainMessages() as never }
    } finally {
      host.stop()
      outer.removeEventListener('abort', stop)
    }
  },
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      // Never is_error: an error is part of the <repl-output>, which resume inference reads from non-error results.
      content: resultText(data),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
