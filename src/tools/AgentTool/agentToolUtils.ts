import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import {
  clearInvokedSkillsForAgent,
  getForwardSubagentText,
  getIsNonInteractiveSession,
} from '../../bootstrap/state.js'
import {
  ALL_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
  CUSTOM_AGENT_DISALLOWED_TOOLS,
  IN_PROCESS_TEAMMATE_ALLOWED_TOOLS,
} from '../../constants/tools.js'
import {
  type AgentOwnRequests,
  startAgentSummarization,
} from '../../services/AgentSummary/agentSummary.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { clearDumpState } from '../../services/api/dumpPrompts.js'
import { providerForAgent } from '../../services/mods/agentOffer.js'
import { deliverAgentReport } from '../../services/mods/agentReport.js'
import type { ModSnapshot } from '../../services/mods/runtime.js'
import { updateTaskState } from '../../utils/task/framework.js'
import {
  getMcpPrefix,
  getMcpServerRuleNames,
  getToolNameForPermissionCheck,
  mcpInfoFromString,
} from '../../services/mcp/mcpStringUtils.js'
import type { AppState } from '../../state/AppState.js'
import type {
  Tool,
  ToolPermissionContext,
  Tools,
  ToolUseContext,
} from '../../Tool.js'
import { toolMatchesName } from '../../Tool.js'
import {
  addAgentTaskWarning,
  completeAgentTask as completeAsyncAgent,
  createActivityDescriptionResolver,
  createProgressTracker,
  enqueueAgentNotification,
  failAgentTask as failAsyncAgent,
  getProgressUpdate,
  isLocalAgentTask,
  refreshLastAssistantProgress,
  killAsyncAgent,
  type LocalAgentTaskState,
  type ProgressTracker,
  updateAgentProgress as updateAsyncAgentProgress,
  updateProgressFromMessage,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { asAgentId } from '../../types/ids.js'
import { killShellTasksForAgent } from '../../tasks/LocalShellTask/killShellTasks.js'
import type { ClaudeAILimits } from '../../services/claudeAiLimits.js'
import type { Message as MessageType } from '../../types/message.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { logForDebugging } from '../../utils/debug.js'
import { isInProtectedNamespace } from '../../utils/envUtils.js'
import { errorMessage, isAbortError } from '../../utils/errors.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  extractTextContent,
  getLastAssistantMessage,
} from '../../utils/messages.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import { permissionRuleValueFromString } from '../../utils/permissions/permissionRuleParser.js'
import {
  normalizeMessage,
  normalizeSubagentMessage,
} from '../../utils/queryHelpers.js'
import { enqueueSdkEvent } from '../../utils/sdkEventQueue.js'
import {
  buildTranscriptForClassifier,
  classifyYoloAction,
} from '../../utils/permissions/yoloClassifier.js'
import { emitTaskProgress as emitTaskProgressEvent } from '../../utils/task/sdkProgress.js'
import { isInProcessTeammate } from '../../utils/teammateContext.js'
import { getTokenCountFromUsage } from '../../utils/tokens.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from '../ExitPlanModeTool/constants.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../SyntheticOutputTool/SyntheticOutputTool.js'
import {
  subagentHandbackReport,
  subagentResultText,
  takeSubagentHandbackResult,
  withSubagentHandbackReport,
} from '../../utils/subagentHandback.js'
import type { SubagentHandbackOutcome } from '../../utils/subagentHandback.js'
import {
  AGENT_TOOL_NAME,
  LEGACY_AGENT_TOOL_NAME,
  ONE_SHOT_BUILTIN_AGENT_TYPES,
} from './constants.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import { parkAgentForChildren } from './backgroundOwner.js'
import { getMaxSubagentDepth } from './subagentDepth.js'
import {
  CODE_MODE_ONLY_TOOLS,
  POLL_TOOL_NAME,
  REPL_PRIMITIVE_TOOL_NAMES,
  REPL_TOOL_NAME,
} from '../REPLTool/constants.js'
import { isCodeModeEnabled } from '../REPLTool/codeModeGate.js'
import { SEND_MESSAGE_TOOL_NAME } from '../SendMessageTool/constants.js'
import { APPLY_PATCH_TOOL_NAME } from '../ApplyPatchTool/prompt.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
export type ResolvedAgentTools = {
  hasWildcard: boolean
  validTools: string[]
  invalidTools: string[]
  /** Specs naming a tool this session has that subagents may not use. */
  unavailableTools: string[]
  resolvedTools: Tools
  allowedAgentTypes?: string[]
}

const agentProgressObservers = new WeakMap<ToolUseContext, (message: MessageType) => void>()

// The exact host call context owns this sink; child context copies do not inherit it.
export function observeAgentProgress(context: ToolUseContext, observer: (message: MessageType) => void): () => void {
  agentProgressObservers.set(context, observer)
  return () => {
    if (agentProgressObservers.get(context) === observer) agentProgressObservers.delete(context)
  }
}

export function reportObservedAgentProgress(context: ToolUseContext, message: MessageType): void {
  agentProgressObservers.get(context)?.(message)
}

export function filterToolsForExactAgent(tools: Tools): Tools {
  // Cache-sharing forks preserve the complete parent tool definitions. Tools
  // restricted to the main thread still reject child calls in validateInput/call.
  return tools
}

export function filterToolsForAgent({
  tools,
  isBuiltIn,
  isAsync = false,
  permissionMode,
  agentDepth = 0,
}: {
  tools: Tools
  isBuiltIn: boolean
  isAsync?: boolean
  permissionMode?: PermissionMode
  agentDepth?: number
}): Tools {
  return tools.filter(tool => {
    // An agent at the nesting limit cannot spawn, so it never sees the Agent tool.
    if (
      agentDepth >= getMaxSubagentDepth() &&
      (toolMatchesName(tool, AGENT_TOOL_NAME) ||
        toolMatchesName(tool, LEGACY_AGENT_TOOL_NAME))
    ) {
      return false
    }
    // Allow MCP tools for all agents
    if (tool.name.startsWith('mcp__')) {
      return true
    }
    // Allow ExitPlanMode for agents in plan mode (e.g., in-process teammates)
    // This bypasses both the ALL_AGENT_DISALLOWED_TOOLS and async tool filters
    if (
      toolMatchesName(tool, EXIT_PLAN_MODE_V2_TOOL_NAME) &&
      permissionMode === 'plan'
    ) {
      return true
    }
    if (ALL_AGENT_DISALLOWED_TOOLS.has(tool.name)) {
      return false
    }
    if (!isBuiltIn && CUSTOM_AGENT_DISALLOWED_TOOLS.has(tool.name)) {
      return false
    }
    if (isAsync && !ASYNC_AGENT_ALLOWED_TOOLS.has(tool.name)) {
      if (isAgentSwarmsEnabled() && isInProcessTeammate()) {
        // Allow AgentTool for in-process teammates to spawn sync subagents.
        // Validation in AgentTool.call() prevents background agents and teammate spawning.
        if (toolMatchesName(tool, AGENT_TOOL_NAME)) {
          return true
        }
        // Allow task tools for in-process teammates to coordinate via shared task list
        if (IN_PROCESS_TEAMMATE_ALLOWED_TOOLS.has(tool.name)) {
          return true
        }
      }
      return false
    }
    return true
  })
}

/**
 * Whether an agent's disallowedTools remove a tool: full names, and MCP
 * server-level specs (mcp__server, mcp__server__*, mcp__*).
 */
export function isToolDisallowedForAgent(
  disallowedTools: string[] | undefined,
): (tool: Tool) => boolean {
  // Create a set of disallowed tool names for quick lookup
  const disallowedToolSet = new Set(
    disallowedTools?.map(toolSpec => {
      const { toolName } = permissionRuleValueFromString(toolSpec)
      return toolName
    }) ?? [],
  )

  // MCP server-level specs (mcp__server, mcp__server__*, mcp__*) remove every
  // tool of that server, or every MCP tool. Like deny rules, they match both the
  // first "__" segment of the tool name and the tool's whole server name.
  let disallowsAllMcp = false
  const disallowedMcpServers = new Set<string>()
  for (const toolName of disallowedToolSet) {
    const info = mcpInfoFromString(toolName)
    if (info && (info.toolName === undefined || info.toolName === '*')) {
      if (info.serverName === '*') disallowsAllMcp = true
      else disallowedMcpServers.add(info.serverName)
    }
  }
  return (tool: Tool): boolean => {
    const permissionName = getToolNameForPermissionCheck(tool)
    if (
      disallowedToolSet.has(tool.name) ||
      disallowedToolSet.has(permissionName) ||
      // apply_patch does Edit's and Write's work, so an agent without either loses it too.
      (tool.name === APPLY_PATCH_TOOL_NAME &&
        (disallowedToolSet.has(FILE_EDIT_TOOL_NAME) || disallowedToolSet.has(FILE_WRITE_TOOL_NAME)))
    ) {
      return true
    }
    const serverName = mcpInfoFromString(permissionName)?.serverName
    if (
      serverName !== undefined &&
      (disallowsAllMcp || disallowedMcpServers.has(serverName))
    ) {
      return true
    }
    return getMcpServerRuleNames(tool).some(
      name => disallowedToolSet.has(name) || disallowedToolSet.has(`${name}__*`),
    )
  }
}

/**
 * Resolves and validates agent tools against available tools
 * Handles wildcard expansion and validation in one place
 */
export function resolveAgentTools(
  agentDefinition: Pick<
    AgentDefinition,
    'tools' | 'disallowedTools' | 'source' | 'permissionMode'
  >,
  availableTools: Tools,
  isAsync = false,
  isMainThread = false,
  agentDepth = 0,
): ResolvedAgentTools {
  const {
    tools: agentTools,
    disallowedTools,
    source,
    permissionMode,
  } = agentDefinition
  // When isMainThread is true, skip filterToolsForAgent entirely — the main
  // thread's tool pool is already properly assembled by useMergedTools(), so
  // the sub-agent disallow lists shouldn't apply.
  const filteredAvailableTools = isMainThread
    ? availableTools
    : filterToolsForAgent({
        tools: availableTools,
        isBuiltIn: source === 'built-in',
        isAsync,
        permissionMode,
        agentDepth,
      })

  const isDisallowed = isToolDisallowedForAgent(disallowedTools)

  // Filter available tools based on disallowed list
  const allowedAvailableTools = filteredAvailableTools.filter(
    tool => !isDisallowed(tool),
  )

  // If tools is undefined or ['*'], allow all tools (after filtering disallowed)
  const hasWildcard =
    agentTools === undefined ||
    (agentTools.length === 1 && agentTools[0] === '*')
  if (hasWildcard) {
    return {
      hasWildcard: true,
      validTools: [],
      invalidTools: [],
      unavailableTools: [],
      resolvedTools: withoutOrphanPoll(allowedAvailableTools, isMainThread),
    }
  }

  const availableToolMap = new Map<string, Tool>()
  for (const tool of allowedAvailableTools) {
    availableToolMap.set(tool.name, tool)
  }
  const replTool = isCodeModeEnabled() ? availableToolMap.get(REPL_TOOL_NAME) : undefined

  const validTools: string[] = []
  const invalidTools: string[] = []
  const unavailableTools: string[] = []
  const poolNames = new Set(availableTools.map(tool => tool.name))
  const resolved: Tool[] = []
  const resolvedToolsSet = new Set<Tool>()
  let allowedAgentTypes: string[] | undefined

  const requiredStructuredOutputTool = availableToolMap.get(
    SYNTHETIC_OUTPUT_TOOL_NAME,
  )
  if (requiredStructuredOutputTool) {
    resolved.push(requiredStructuredOutputTool)
    resolvedToolsSet.add(requiredStructuredOutputTool)
  }

  for (const toolSpec of agentTools) {
    // Parse the tool spec to extract the base tool name and any permission pattern
    const { toolName, ruleContent } = permissionRuleValueFromString(toolSpec)

    // Special case: Agent tool carries allowedAgentTypes metadata in its spec
    if (toolName === AGENT_TOOL_NAME) {
      if (ruleContent) {
        // Parse comma-separated agent types: "worker, researcher" → ["worker", "researcher"]
        allowedAgentTypes = ruleContent.split(',').map(s => s.trim())
      }
      // A withheld Agent spec still carries type restrictions for the child.
      // An available Agent must resolve normally so nested calls can execute.
      if (!isMainThread && !availableToolMap.has(AGENT_TOOL_NAME)) {
        validTools.push(toolSpec)
        continue
      }
    }

    // Like official 2.1.311: mcp__server and mcp__server__* grant every tool of
    // that server. A server whose name contains "__" is reached only through
    // its full name with "__*".
    const mcpSpec = mcpInfoFromString(toolName)
    const serverLevel =
      mcpSpec !== null &&
      mcpSpec.serverName !== '*' &&
      (mcpSpec.toolName === undefined || mcpSpec.toolName === '*')
    const serverRule = serverLevel
      ? `mcp__${mcpSpec.serverName}`
      : mcpSpec !== null && toolName.endsWith('__*')
        ? toolName.slice(0, -3)
        : undefined
    if (serverRule !== undefined) {
      const serverTools = allowedAvailableTools.filter(
        t => t.mcpInfo && getMcpPrefix(t.mcpInfo.serverName) === `${serverRule}__`,
      )
      if (serverLevel || serverTools.length > 0) {
        validTools.push(toolSpec)
        if (serverTools.length === 0) {
          logForDebugging(
            `Agent tools entry "${toolSpec}" takes no tool: no connected MCP server of that name has one.`,
            { level: 'warn' },
          )
        }
        for (const serverTool of serverTools) {
          if (!resolvedToolsSet.has(serverTool)) {
            resolved.push(serverTool)
            resolvedToolsSet.add(serverTool)
          }
        }
        continue
      }
    }

    const tool = availableToolMap.get(toolName)
    if (tool) {
      validTools.push(toolSpec)
      if (!resolvedToolsSet.has(tool)) {
        resolved.push(tool)
        resolvedToolsSet.add(tool)
      }
    } else if (replTool && CODE_MODE_ONLY_TOOLS.has(toolName)) {
      // Code Mode took Read, Bash, ... out of the pool; the agent reaches them
      // through REPL, limited by its primitiveToolGrant (official yM).
      validTools.push(toolSpec)
      if (!resolvedToolsSet.has(replTool)) {
        resolved.push(replTool)
        resolvedToolsSet.add(replTool)
      }
    } else if (isDisallowed({ name: toolName } as Tool)) {
      // Official yM: a spec the agent's own disallowedTools removes is neither.
    } else if (poolNames.has(toolName)) {
      unavailableTools.push(toolSpec)
    } else {
      invalidTools.push(toolSpec)
    }
  }

  const pollTool = availableToolMap.get(POLL_TOOL_NAME)
  if (replTool && resolvedToolsSet.has(replTool) && pollTool && !resolvedToolsSet.has(pollTool)) {
    resolved.push(pollTool)
  }

  return {
    hasWildcard: false,
    validTools,
    invalidTools,
    unavailableTools,
    resolvedTools: withoutOrphanPoll(resolved, isMainThread),
    allowedAgentTypes,
  }
}

/**
 * Official 2.1.325 runAgent: an agent left with no tools at all is refused
 * when its own tools list is why (named tools, none of them usable here) and
 * the session had tools to give; a wildcard or a continuation only logs it.
 * Returns the refusal text, or undefined to spawn the agent anyway.
 */
export function zeroToolSpawnRefusal(
  agentDefinition: Pick<AgentDefinition, 'agentType' | 'disallowedTools' | 'source'>,
  resolution: ResolvedAgentTools | undefined,
  availablePoolSize: number,
  { isAsync, isContinuation }: { isAsync: boolean; isContinuation: boolean },
): string | undefined {
  const invalid = resolution?.invalidTools ?? []
  const unavailable = resolution?.unavailableTools ?? []
  const isDisallowed = isToolDisallowedForAgent(agentDefinition.disallowedTools)
  const validButEmpty = (resolution?.validTools ?? []).filter(spec => !isDisallowed({ name: spec } as Tool))
  const reasons = [
    invalid.length ? `unrecognized [${invalid.join(', ')}]` : '',
    unavailable.length ? `not available to subagents [${unavailable.join(', ')}]` : '',
    validButEmpty.length ? `recognized but matched no tools in this session [${validButEmpty.join(', ')}]` : '',
  ]
    .filter(Boolean)
    .join('; ')
  const refused =
    reasons !== '' && resolution !== undefined && !resolution.hasWildcard && availablePoolSize > 0 && !isContinuation
  logEvent('tengu_subagent_zero_tools', {
    isBuiltIn: agentDefinition.source === 'built-in',
    invalidCount: invalid.length,
    unavailableCount: unavailable.length,
    validButEmptyCount: validButEmpty.length,
    availablePoolSize,
    hadWildcard: resolution?.hasWildcard ?? false,
    isContinuation,
    refused,
    isAsync,
  })
  if (!refused) return undefined
  return (
    `Agent '${agentDefinition.agentType}' would be spawned with zero tools \u2014 refusing. ` +
    `Its tools list resolved to nothing: ${reasons}. Fix the agent's tools frontmatter or pass a different subagent_type.`
  )
}

/** Poll only answers REPL runs, so a subagent left without REPL loses it too (official Ma). */
function withoutOrphanPoll(tools: Tools, isMainThread: boolean): Tools {
  if (isMainThread || !isCodeModeEnabled() || tools.some(tool => toolMatchesName(tool, REPL_TOOL_NAME))) {
    return tools
  }
  return tools.filter(tool => !toolMatchesName(tool, POLL_TOOL_NAME))
}

/**
 * The Code Mode primitives an agent's REPL scripts may call: its tools list
 * resolved against REPL_PRIMITIVE_TOOL_NAMES, so a wildcard or no list grants
 * all of them and disallowedTools takes some away (official VQt).
 */
export function primitiveToolGrant(
  agentDefinition: Pick<AgentDefinition, 'tools' | 'disallowedTools' | 'source' | 'permissionMode'>,
): ReadonlySet<string> {
  const primitives = [...REPL_PRIMITIVE_TOOL_NAMES].map(name => ({ name }) as Tool)
  return new Set(
    resolveAgentTools(agentDefinition, primitives, false, true).resolvedTools.map(tool => tool.name),
  )
}

export const agentToolResultSchema = lazySchema(() =>
  z.object({
    agentId: z.string(),
    // Optional: older persisted sessions won't have this (resume replays
    // results verbatim without re-validation). Used to gate the sync
    // result trailer — one-shot built-ins skip the SendMessage hint.
    agentType: z.string().optional(),
    content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
    totalToolUseCount: z.number(),
    totalDurationMs: z.number(),
    totalTokens: z.number(),
    usage: z.object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_creation_input_tokens: z.number().nullable(),
      cache_read_input_tokens: z.number().nullable(),
      server_tool_use: z
        .object({
          web_search_requests: z.number(),
          web_fetch_requests: z.number(),
        })
        .nullable(),
      service_tier: z.enum(['standard', 'priority', 'batch']).nullable(),
      cache_creation: z
        .object({
          ephemeral_1h_input_tokens: z.number(),
          ephemeral_5m_input_tokens: z.number(),
        })
        .nullable(),
    }),
    structured_output: z.unknown().optional(),
    // How a SubagentHandback run's report reached this result: 'send' and
    // 'flagged' hold the delivered report (a flagged one under its review
    // warning, the first harness note); 'withheld' delivered nothing.
    handback: z.enum(['send', 'flagged', 'withheld']).optional(),
    // The SubagentHandback call that delivered a 'send' or 'flagged' report.
    handbackToolUseId: z.string().optional(),
    harnessNoteCount: z.number().optional(),
    harnessTailCount: z.number().optional(),
    harnessSectionHash: z.string().optional(),
    // Set when the run stopped at its maxTurns limit; content is then partial.
    turnLimit: z.number().optional(),
  }),
)

export type AgentToolResult = z.input<ReturnType<typeof agentToolResultSchema>>

function turnLimitFromMessages(messages: MessageType[]): number | undefined {
  const attachment = messages.findLast(
    message => message.type === 'attachment' && message.attachment.type === 'max_turns_reached',
  )
  return attachment?.type === 'attachment' && attachment.attachment.type === 'max_turns_reached'
    ? attachment.attachment.maxTurns
    : undefined
}

function structuredOutputFromMessages(messages: MessageType[]): unknown {
  const attachment = messages.findLast(
    message => message.type === 'attachment' && message.attachment.type === 'structured_output',
  )
  return attachment?.type === 'attachment' && attachment.attachment.type === 'structured_output'
    ? attachment.attachment.data
    : undefined
}

// Like official 2.1.303, a usage-limit 429 keeps its quota state so a workflow can wait for the reset.
export class AgentApiError extends Error {
  constructor(
    message: string,
    readonly quotaLimits: ClaudeAILimits | undefined,
    /** The API error as the response said it, which a workflow agent's row shows. */
    readonly responseText?: string,
  ) {
    super(message)
  }
}

// Like official 2.1.329, a run that ended on an API error fails with the termination text,
// which the task's error, its SDK task_notification summary and the parent's notice all show.
export function getAgentTerminalError(messages: MessageType[], runModel: string): Error | undefined {
  const lastAssistantMessage = getLastAssistantMessage(messages)
  if (!lastAssistantMessage?.isApiErrorMessage && !lastAssistantMessage?.error) {
    return undefined
  }
  const text = extractTextContent(lastAssistantMessage.message.content, '\n').trim()
  const message = agentApiTerminationText(messages, runModel) ?? text
  return new AgentApiError(
    message || errorMessage(lastAssistantMessage.error) || 'Agent API request failed',
    lastAssistantMessage.error === 'rate_limit' ? lastAssistantMessage.quotaLimits : undefined,
    text || undefined,
  )
}

/**
 * Official 2.1.329 AgentApiErrorTerminationError's text for a run whose last
 * response is an API error, with what places it: the error type, HTTP status,
 * request id and the model a request reached (the run's model unless the response names another).
 */
export function agentApiTerminationText(messages: MessageType[], runModel: string): string | undefined {
  const last = getLastAssistantMessage(messages)
  if (!last?.isApiErrorMessage) return undefined
  const text = extractTextContent(last.message.content, '\n')
  const sent = last.apiErrorStatus !== undefined || !!last.requestId
  const details = [
    last.error && `error type ${String(last.error)}`,
    last.apiErrorStatus !== undefined && `HTTP ${last.apiErrorStatus}`,
    last.requestId && `request id ${last.requestId}`,
    sent && `model sent to the API: ${last.requestedModel ?? runModel}`,
  ].filter((detail): detail is string => typeof detail === 'string')
  return `Agent terminated early due to an API error: ${details.length > 0 ? `${text} (${details.join(', ')})` : text}`
}

export function countToolUses(messages: MessageType[]): number {
  let count = 0
  for (const m of messages) {
    if (m.type === 'assistant') {
      for (const block of m.message.content) {
        if (block.type === 'tool_use') {
          count++
        }
      }
    }
  }
  return count
}

type PendingToolUse = {
  id?: string
  name?: string
}

export function findUnresolvedToolUses(messages: MessageType[]): PendingToolUse[] {
  const pendingToolUses = new Map<string, PendingToolUse>()
  const unmatchableToolUses: PendingToolUse[] = []

  for (const message of messages) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type !== 'tool_use') continue
        const name = typeof block.name === 'string' ? block.name : undefined
        if (typeof block.id === 'string' && block.id.length > 0) {
          pendingToolUses.set(block.id, { id: block.id, name })
        } else {
          unmatchableToolUses.push({ name })
        }
      }
      continue
    }

    if (message.type !== 'user' || !Array.isArray(message.message.content)) {
      continue
    }

    for (const block of message.message.content) {
      if (
        block.type === 'tool_result' &&
        typeof block.tool_use_id === 'string'
      ) {
        pendingToolUses.delete(block.tool_use_id)
      }
    }
  }

  return [...unmatchableToolUses, ...pendingToolUses.values()]
}

function formatPendingToolUse(toolUse: PendingToolUse): string {
  const toolName = toolUse.name ?? 'unknown tool'
  return toolUse.id ? `${toolName} (${toolUse.id})` : `${toolName} (missing id)`
}

export function finalizeAgentTool(
  agentMessages: MessageType[],
  agentId: string,
  metadata: {
    prompt: string
    resolvedAgentModel: string
    isBuiltInAgent: boolean
    startTime: number
    agentType: string
    isAsync: boolean
  },
): AgentToolResult {
  const {
    prompt,
    resolvedAgentModel,
    isBuiltInAgent,
    startTime,
    agentType,
    isAsync,
  } = metadata

  const lastAssistantMessage = getLastAssistantMessage(agentMessages)
  if (lastAssistantMessage === undefined) {
    throw new Error('No assistant messages found')
  }
  const terminalError = getAgentTerminalError(agentMessages, resolvedAgentModel)
  if (terminalError) throw terminalError
  const unresolvedToolUses = findUnresolvedToolUses(agentMessages)
  if (unresolvedToolUses.length > 0) {
    const pending = unresolvedToolUses.map(formatPendingToolUse).join(', ')
    throw new Error(`Agent stopped with unresolved tool use: ${pending}`)
  }
  // Extract text content from the agent's response. If the final assistant
  // message is a pure tool_use block (loop exited mid-turn), fall back to
  // the most recent assistant message that has text content.
  let content = lastAssistantMessage.message.content.filter(
    _ => _.type === 'text',
  )
  if (content.length === 0) {
    for (let i = agentMessages.length - 1; i >= 0; i--) {
      const m = agentMessages[i]!
      if (m.type !== 'assistant') continue
      const textBlocks = m.message.content.filter(_ => _.type === 'text')
      if (textBlocks.length > 0) {
        content = textBlocks
        break
      }
    }
  }

  // @ts-ignore - recovered code
  const totalTokens = getTokenCountFromUsage(lastAssistantMessage.message.usage)
  const totalToolUseCount = countToolUses(agentMessages)

  logEvent('tengu_agent_tool_completed', {
    agent_type:
      agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    model:
      resolvedAgentModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    prompt_char_count: prompt.length,
    response_char_count: content.length,
    assistant_message_count: agentMessages.length,
    total_tool_uses: totalToolUseCount,
    duration_ms: Date.now() - startTime,
    total_tokens: totalTokens,
    is_built_in_agent: isBuiltInAgent,
    is_async: isAsync,
  })

  // Signal to inference that this subagent's cache chain can be evicted.
  const lastRequestId = lastAssistantMessage.requestId
  if (lastRequestId) {
    logEvent('tengu_cache_eviction_hint', {
      scope:
        'subagent_end' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      last_request_id:
        lastRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  const turnLimit = turnLimitFromMessages(agentMessages)
  if (turnLimit !== undefined) {
    // Same notice as official 2.1.311, so the parent continues the agent
    // instead of taking the partial output as its report.
    const note = `NOTE: this agent stopped at its ${turnLimit}-turn limit before finishing.${content.length === 0 ? ' It was still calling tools and had produced no report.' : ' The text below is PARTIAL output; treat it as incomplete.'} Send the agent a message (${SEND_MESSAGE_TOOL_NAME}) to let it continue from where it stopped.\n`
    content = [{ type: 'text', text: note }, ...content]
  }

  const structuredOutput = structuredOutputFromMessages(agentMessages)
  // A hand-back run's result is the report it delivered, never its last text.
  const handback = takeSubagentHandbackResult(
    agentId,
    !ONE_SHOT_BUILTIN_AGENT_TYPES.has(agentType),
  )
  return {
    agentId,
    agentType,
    // @ts-ignore - recovered code
    content,
    ...handback,
    totalDurationMs: Date.now() - startTime,
    totalTokens,
    totalToolUseCount,
    usage: lastAssistantMessage.message.usage,
    ...(turnLimit !== undefined && { turnLimit }),
    ...(structuredOutput === undefined
      ? {}
      : { structured_output: structuredOutput }),
  }
}

/**
 * Returns the name of the last tool_use block in an assistant message,
 * or undefined if the message is not an assistant message with tool_use.
 */
export function getLastToolUseName(message: MessageType): string | undefined {
  if (message.type !== 'assistant') return undefined
  const block = message.message.content.findLast(b => b.type === 'tool_use')
  // @ts-ignore - recovered code
  return block?.type === 'tool_use' ? block.name : undefined
}

export function emitTaskProgress(
  tracker: ProgressTracker,
  taskId: string,
  toolUseId: string | undefined,
  description: string,
  startTime: number,
  lastToolName: string,
  subagentType?: string,
): void {
  const progress = getProgressUpdate(tracker)
  emitTaskProgressEvent({
    taskId,
    toolUseId,
    description: progress.lastActivity?.activityDescription ?? description,
    startTime,
    totalTokens: progress.tokenCount,
    toolUses: progress.toolUseCount,
    lastToolName,
    subagentType,
  })
}

export async function classifyHandoffIfNeeded({
  agentMessages,
  tools,
  toolPermissionContext,
  abortSignal,
  subagentType,
  totalToolUseCount,
  onReview,
}: {
  agentMessages: MessageType[]
  tools: Tools
  toolPermissionContext: AppState['toolPermissionContext']
  abortSignal: AbortSignal
  subagentType: string
  totalToolUseCount: number
  onReview?: (review:'cleared'|'flagged'|'unavailable') => void
}): Promise<string | null> {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    if (toolPermissionContext.mode !== 'auto') return null

    const agentTranscript = buildTranscriptForClassifier(agentMessages, tools)
    if (!agentTranscript) return null

    const classifierResult = await classifyYoloAction(
      agentMessages,
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: "Sub-agent has finished and is handing back control to the main agent. Review the sub-agent's work based on the block rules and let the main agent know if any file is dangerous (the main agent will see the reason).",
          },
        ],
      },
      tools,
      toolPermissionContext as ToolPermissionContext,
      abortSignal,
    )

    onReview?.(classifierResult.unavailable ? 'unavailable' : classifierResult.shouldBlock ? 'flagged' : 'cleared')
    const handoffDecision = classifierResult.unavailable
      ? 'unavailable'
      : classifierResult.shouldBlock
        ? 'blocked'
        : 'allowed'
    logEvent('tengu_auto_mode_decision', {
      decision:
        handoffDecision as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      toolName:
        // Use legacy name for analytics continuity across the Task→Agent rename
        LEGACY_AGENT_TOOL_NAME as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      inProtectedNamespace: isInProtectedNamespace(),
      classifierModel:
        classifierResult.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      agentType:
        subagentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      toolUseCount: totalToolUseCount,
      isHandoff: true,
      // For handoff, the relevant agent completion is the subagent's final
      // assistant message — the last thing the classifier transcript shows
      // before the handoff review prompt.
      agentMsgId: getLastAssistantMessage(agentMessages)?.message
        .id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage:
        classifierResult.stage as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage1RequestId:
        classifierResult.stage1RequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage1MsgId:
        classifierResult.stage1MsgId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage2RequestId:
        classifierResult.stage2RequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage2MsgId:
        classifierResult.stage2MsgId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    if (classifierResult.shouldBlock) {
      // When classifier is unavailable, still propagate the sub-agent's
      // results but with a warning so the parent agent can verify the work.
      if (classifierResult.unavailable) {
        logForDebugging(
          'Handoff classifier unavailable, allowing sub-agent output with warning',
          { level: 'warn' },
        )
        return `Note: The safety classifier was unavailable when reviewing this sub-agent's work. Please carefully verify the sub-agent's actions and output before acting on them.`
      }

      logForDebugging(
        `Handoff classifier flagged sub-agent output: ${classifierResult.reason}`,
        { level: 'warn' },
      )
      return `SECURITY WARNING: This sub-agent performed actions that may violate security policy. Reason: ${classifierResult.reason}. Review the sub-agent's actions carefully before acting on its output.`
    }
  }

  return null
}

/**
 * Extract a partial result string from an agent's accumulated messages.
 * Used when an async agent is killed to preserve what it accomplished.
 * Returns undefined if no text content is found.
 */
export function extractPartialResult(
  messages: MessageType[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.type !== 'assistant') continue
    const text = extractTextContent(m.message.content, '\n')
    if (text) {
      return text
    }
  }
  return undefined
}

type AgentReportReview = { review: 'cleared' | 'flagged' | 'refused' | 'unavailable' | 'none' | 'off'; warning?: string }
type AgentReportAnswer = { text: string; review: AgentReportReview['review']; warning?: string } | { consumed: string }
type AgentReport = { text: string; review: () => Promise<AgentReportReview>; handback?: SubagentHandbackOutcome; handbackToolUseId?: string }

/** Who a run reports as to agent.report; read at launch, as a task drops its agent when the run ends. */
export type AgentReportTarget = { agent: AgentDefinition; parentAgentId?: string }

/** Whether the mode runs auto mode's hand-off review; agent.report reports `off` where it does not. */
const handoffReviewRuns = (toolPermissionContext: ToolPermissionContext): boolean =>
  feature('TRANSCRIPT_CLASSIFIER') ? toolPermissionContext.mode === 'auto' : false

/** A failed or stopped run's report: nothing reviewed it, `none` in auto mode and `off` in a mode with no review. */
export const unreviewedAgentReport = (text: string, toolUseContext: Pick<ToolUseContext, 'getAppState'>): AgentReport => ({
  text,
  review: async () => ({ review: handoffReviewRuns(toolUseContext.getAppState().toolPermissionContext) ? 'none' : 'off' }),
})

/** auto mode's handoff review of a finished run, as agent.report's review. */
export async function reviewAgentHandoff(
  args: Omit<Parameters<typeof classifyHandoffIfNeeded>[0], 'onReview'>,
): Promise<AgentReportReview> {
  if (!handoffReviewRuns(args.toolPermissionContext)) return { review: 'off' }
  let review: AgentReportReview['review'] = 'none'
  const warning = await classifyHandoffIfNeeded({ ...args, onReview: value => { review = value } })
  return { review, ...(warning && { warning }) }
}

/** A finished run's own report: a hand-back carries the verdict its call got; anything else is reviewed by `review`. */
export function agentReportOf(result: AgentToolResult, review: () => Promise<AgentReportReview>): AgentReport {
  if (result.handback === undefined) return { text: subagentResultText(result), review }
  const { text, ...verdict } = subagentHandbackReport({ ...result, handback: result.handback })
  return { text, review: async () => verdict, handback: result.handback, ...(result.handbackToolUseId !== undefined && { handbackToolUseId: result.handbackToolUseId }) }
}

/**
 * agent.report between a run's end and its parent. With no hook, or no
 * target (a workflow's agent()), only the review runs; its warning still
 * reaches the parent.
 */
export async function reportAgentEnd(
  snapshot: ModSnapshot | undefined,
  target: AgentReportTarget | undefined,
  agentId: string,
  status: 'completed' | 'failed' | 'stopped',
  report: AgentReport,
): Promise<AgentReportAnswer> {
  let reviewed: Promise<AgentReportReview> | undefined
  const review = () => (reviewed ??= report.review())
  const unreported = async () => {
    const { review: verdict, warning } = await review()
    return { text: report.text, review: verdict, ...(warning && { warning }) }
  }
  if (!target || !snapshot || !(snapshot.hasHooks('agent.report') || snapshot.agentReportWarnings?.has(agentId))) return unreported()
  try {
    const answer = await deliverAgentReport(snapshot, {
      agentId,
      subagentType: target.agent.agentType,
      provider: providerForAgent(target.agent, snapshot),
      ...(target.parentAgentId && { parentAgentId: target.parentAgentId }),
      status,
      text: report.text,
    }, review)
    return 'consumed' in answer ? answer : { text: answer.text, review: answer.review, ...(answer.warning && { warning: answer.warning }) }
  } catch (error) {
    // The parent still gets the run's own report, reviewed once.
    logForDebugging(`agent.report failed for agent ${agentId}: ${errorMessage(error)}`, { level: 'warn' })
    return unreported()
  }
}

/** The result a parent reads once agent.report answered; a consumed report leaves only its reason. */
export function applyAgentReport<T extends AgentToolResult>(result: T, report: AgentReport, answer: { text: string; warning?: string } | { consumed: string }): T {
  if ('consumed' in answer) {
    const { handback, handbackToolUseId: _call, harnessNoteCount: _notes, harnessTailCount: _tail, harnessSectionHash: _hash, ...rest } = result
    // The reason is the mod's, not the agent's: a hand-back shows it as a note, with no report under a frame.
    return { ...rest, ...(handback !== undefined && { handback: 'withheld' }), content: [{ type: 'text', text: answer.consumed }] } as T
  }
  if (result.handback !== undefined) {
    const own = subagentHandbackReport({ ...result, handback: result.handback })
    if (answer.text === own.text && answer.warning === own.warning) return result
    return { ...result, ...withSubagentHandbackReport({ ...result, handback: result.handback }, answer.text, answer.warning) }
  }
  const content = answer.text === report.text ? result.content : [{ type: 'text' as const, text: answer.text }]
  return { ...result, content: answer.warning ? [{ type: 'text' as const, text: answer.warning }, ...content] : content }
}

/** Runs `fn` on a snapshot of the mods now loaded, as a report can outlive the turn that started its run. */
export async function withAgentReportSnapshot<T>(
  toolUseContext: Pick<ToolUseContext, 'mods' | 'modsSnapshot'>,
  fn: (snapshot: ModSnapshot | undefined) => Promise<T>,
): Promise<T> {
  let owned: ModSnapshot | undefined
  try {
    owned = toolUseContext.mods?.capture()
  } catch (error) {
    logForDebugging(`agent.report could not capture mods: ${errorMessage(error)}`, { level: 'warn' })
  }
  try {
    return await fn(owned ?? toolUseContext.modsSnapshot)
  } finally {
    owned?.release()
  }
}

type AgentNotice = Parameters<typeof enqueueAgentNotification>[0]

/**
 * The one end of a background run: agent.report, then the parent's
 * notification, its result built by `message` from the answer. A consumed
 * report notifies no one, but the run counts as notified so nothing waits on
 * it. Returns the answer, or undefined when the run was already notified. A
 * run stopped in a sweep counts as notified from the kill, yet still reports.
 */
export async function notifyAgentEnd(
  toolUseContext: ToolUseContext,
  target: AgentReportTarget | undefined,
  notice: Omit<AgentNotice, 'finalMessage' | 'consumed'>,
  report: AgentReport,
  message: (answer: { text: string; warning?: string }) => string | undefined,
  { deliver = true }: { deliver?: boolean } = {},
): Promise<AgentReportAnswer | undefined> {
  const task = (toolUseContext.getAppStateForTasks ?? toolUseContext.getAppState)().tasks[notice.taskId]
  if (isLocalAgentTask(task) && task.notified && !task.waitingNotice && task.status !== 'killed') return undefined
  const status = notice.status === 'killed' ? 'stopped' : notice.status
  const answer = await withAgentReportSnapshot(toolUseContext, snapshot =>
    reportAgentEnd(snapshot, target, notice.taskId, status, report))
  if (!deliver) return answer
  if ('consumed' in answer) enqueueAgentNotification({ ...notice, consumed: answer.consumed })
  else enqueueAgentNotification({ ...notice, finalMessage: message(answer), ...reportForSdk(report, answer) })
  return answer
}

/**
 * How SDK hosts show a delivered report, as official 2.1.329: a hand-back as
 * the report it delivered, anything else as its summary when no review of it
 * is to come (`off`) and it carries no warning.
 */
function reportForSdk(report: AgentReport, answer: { text: string; review: AgentReportReview['review']; warning?: string }): Pick<AgentNotice, 'summaryIsReport' | 'handback' | 'handbackReport'> {
  if (report.handback === undefined) return { summaryIsReport: answer.review === 'off' && !answer.warning && answer.text.trim() !== '' }
  if (report.handback === 'withheld') return { handback: 'withheld' }
  return { handback: answer.warning ? 'flagged' : 'send', handbackReport: {
    text: answer.text,
    ...(answer.warning && { warning: answer.warning }),
    ...(report.handbackToolUseId !== undefined && { toolUseId: report.handbackToolUseId }),
  } }
}

/** auto mode's review of a finished background run; a review that fails is a post-processing warning. */
export function backgroundHandoffReview({
  taskId,
  agentMessages,
  toolUseContext,
  abortSignal,
  subagentType,
  totalToolUseCount,
  setAppState,
  failureWarning,
}: {
  taskId: string
  agentMessages: MessageType[]
  toolUseContext: ToolUseContext
  abortSignal: AbortSignal
  subagentType: string
  totalToolUseCount: number
  setAppState: SetAppState
  failureWarning: string
}): () => Promise<AgentReportReview> {
  return async () => {
    try {
      return await reviewAgentHandoff({
        agentMessages,
        tools: toolUseContext.options.tools,
        toolPermissionContext: toolUseContext.getAppState().toolPermissionContext,
        abortSignal,
        subagentType,
        totalToolUseCount,
      })
    } catch (error) {
      logForDebugging(
        `Agent handoff classification failed after completion: ${errorMessage(error)}`,
        { level: 'warn' },
      )
      addAgentTaskWarning(taskId, failureWarning, setAppState)
      return { review: 'unavailable', warning: failureWarning }
    }
  }
}

/**
 * The notification text for a finished background run once agent.report
 * answered: a hand-back's warning is a note above its frame, a plain
 * result's a paragraph above it.
 */
export function reportedAgentMessage(result: AgentToolResult, answer: { text: string; warning?: string }, prefix?: string): string {
  const plain = result.handback === undefined
  const reported = applyAgentReport(result, agentReportOf(result, async () => ({ review: 'none' })), plain ? { text: answer.text } : answer)
  return [prefix, plain ? answer.warning : undefined, subagentResultText(reported)].filter(Boolean).join('\n\n')
}

/** A parked owner's last notification: it reports once its own agents have, with the result it parked on. */
export function parkedAgentEnd(
  toolUseContext: ToolUseContext,
  target: AgentReportTarget | undefined,
  review: () => Promise<AgentReportReview>,
): NonNullable<Parameters<typeof parkAgentForChildren>[0]['notifyEnd']> {
  return (notice, result) => {
    const own = result ? agentReportOf(result, review) : unreviewedAgentReport('', toolUseContext)
    return notifyAgentEnd(toolUseContext, target, notice, notice.status === 'completed' ? own : unreviewedAgentReport(own.text, toolUseContext),
      answer => result ? reportedAgentMessage(result, answer) : answer.text || undefined)
  }
}

type SetAppState = (f: (prev: AppState) => AppState) => void

/**
 * Drives a background agent from spawn to terminal notification.
 * Shared between AgentTool's async-from-start path and resumeAgentBackground.
 */
export async function runAsyncAgentLifecycle({
  taskId,
  abortController,
  makeStream,
  metadata,
  description,
  toolUseContext,
  rootSetAppState,
  agentIdForCleanup,
  enableSummarization,
  getWorktreeResult,
  onRunSettled,
  priorToolUses,
  resume,
  shouldNotifyOwner,
  unreported,
}: {
  taskId: string
  abortController: AbortController
  makeStream: (
    onCacheSafeParams: ((p: CacheSafeParams, ownRequests: AgentOwnRequests) => void) | undefined,
  ) => AsyncGenerator<MessageType, void>
  metadata: Parameters<typeof finalizeAgentTool>[2]
  description: string
  toolUseContext: ToolUseContext
  rootSetAppState: SetAppState
  agentIdForCleanup: string
  enableSummarization: boolean
  onRunSettled?: () => void
  /** Tool calls of the runs before this one, so a resumed agent reports its whole count. */
  priorToolUses?: number
  resume?: (prompt: string, promptIsMeta?: boolean) => Promise<unknown>
  shouldNotifyOwner?: () => boolean
  /** A workflow's agent() raises no agent.report. */
  unreported?: boolean
  getWorktreeResult: () => Promise<{
    worktreePath?: string
    worktreeBranch?: string
  }>
}): Promise<void> {
  let stopSummarization: (() => void) | undefined
  const postProcessingWarning =
    'Agent post-processing could not complete. Review the agent output before continuing.'
  const agentMessages: MessageType[] = []
  const tracker = createProgressTracker()
  tracker.toolUseCount = priorToolUses ?? 0
  const resolveActivity = createActivityDescriptionResolver(
    toolUseContext.options.tools,
  )
  // runAgent leaves this agent's background shells running (keepBackgroundShells)
  // so a parked owner can wait on them; every other exit reclaims them here.
  const killOwnShells = () =>
    killShellTasksForAgent(
      asAgentId(taskId),
      toolUseContext.getAppStateForTasks ?? toolUseContext.getAppState,
      rootSetAppState,
    )
  const launched = toolUseContext.getAppState().tasks[taskId]
  const reportTarget: AgentReportTarget | undefined = !unreported && isLocalAgentTask(launched) && launched.selectedAgent
    ? { agent: launched.selectedAgent, ...(launched.parentAgentId && { parentAgentId: launched.parentAgentId }) }
    : undefined
  // An inline resume hands its result to the waiting call, which reads it from the task.
  const end = async (notice: Parameters<typeof notifyAgentEnd>[2], report: AgentReport, message: Parameters<typeof notifyAgentEnd>[4]) => {
    const deliver = shouldNotifyOwner?.() !== false
    const answer = await notifyAgentEnd(toolUseContext, reportTarget, notice, report, message, { deliver })
    if (deliver || !answer) return
    updateTaskState<LocalAgentTaskState>(taskId, rootSetAppState, task =>
      task.result ? { ...task, result: applyAgentReport(task.result, report, answer) } : task)
  }
  try {
    const onCacheSafeParams = enableSummarization
      ? (params: CacheSafeParams, ownRequests: AgentOwnRequests) => {
          stopSummarization?.()
          const { stop } = startAgentSummarization(
            taskId,
            asAgentId(taskId),
            params,
            rootSetAppState,
            ownRequests,
          )
          stopSummarization = stop
        }
      : undefined
    for await (const message of makeStream(onCacheSafeParams)) {
      refreshLastAssistantProgress(
        tracker,
        agentMessages,
        resolveActivity,
        toolUseContext.options.tools,
      )
      agentMessages.push(message)
      // Append immediately when UI holds the task (retain). Bootstrap reads
      // disk in parallel and UUID-merges the prefix — disk-write-before-yield
      // means live is always a suffix of disk, so merge is order-correct.
      rootSetAppState(prev => {
        const t = prev.tasks[taskId]
        if (!isLocalAgentTask(t) || !t.retain) return prev
        const base = t.messages ?? []
        return {
          ...prev,
          tasks: {
            ...prev.tasks,
            [taskId]: { ...t, messages: [...base, message] },
          },
        }
      })
      updateProgressFromMessage(
        tracker,
        message,
        resolveActivity,
        toolUseContext.options.tools,
      )
      updateAsyncAgentProgress(
        taskId,
        getProgressUpdate(tracker),
        rootSetAppState,
      )
      reportObservedAgentProgress(toolUseContext, message)
      // SDK consumers see a background agent's messages live, like official.
      if (getIsNonInteractiveSession() && toolUseContext.toolUseId) {
        // Nested subagents' messages arrive as progress; like 2.1.311 they
        // reach the SDK only with --forward-subagent-text.
        const sdkMessages =
          message.type !== 'progress'
            ? normalizeSubagentMessage(message, toolUseContext.toolUseId, {
                agentId: taskId,
                agentType: metadata.agentType,
                description,
              })
            : getForwardSubagentText() &&
                (message.data.type === 'agent_progress' ||
                  message.data.type === 'skill_progress')
              ? normalizeMessage(message)
              : []
        for (const sdkMessage of sdkMessages) {
          enqueueSdkEvent(sdkMessage)
        }
      }
      const lastToolName = getLastToolUseName(message)
      if (lastToolName) {
        emitTaskProgress(
          tracker,
          taskId,
          toolUseContext.toolUseId,
          description,
          metadata.startTime,
          lastToolName,
          metadata.agentType,
        )
      }
    }

    stopSummarization?.()

    refreshLastAssistantProgress(
      tracker,
      agentMessages,
      resolveActivity,
      toolUseContext.options.tools,
    )
    const finalProgress = getProgressUpdate(tracker)
    updateAsyncAgentProgress(taskId, finalProgress, rootSetAppState)

    const agentResult = finalizeAgentTool(agentMessages, taskId, metadata)

    // Mark task completed FIRST so TaskOutput(block=true) unblocks
    // immediately. classifyHandoffIfNeeded (API call) and getWorktreeResult
    // (git exec) are notification embellishments that can hang — they must
    // not gate the status transition (gh-20236).
    onRunSettled?.()
    completeAsyncAgent(agentResult, rootSetAppState)
    const review = backgroundHandoffReview({
      taskId,
      agentMessages,
      toolUseContext,
      abortSignal: abortController.signal,
      subagentType: metadata.agentType,
      totalToolUseCount: agentResult.totalToolUseCount,
      setAppState: rootSetAppState,
      failureWarning: postProcessingWarning,
    })
    const report = agentReportOf(agentResult, review)
    const notifyEnd = parkedAgentEnd(toolUseContext, reportTarget, review)
    if (parkAgentForChildren({ taskId, toolUseContext, resume, getWorktreeResult, notifyEnd })) {
      const parked = toolUseContext.getAppState().tasks[taskId]
      const ownWork = isLocalAgentTask(parked) && [...parked.keepaliveReasons ?? []].some(reason => reason.startsWith('shell:'))
      const delivered = agentResult.handback === 'send' || agentResult.handback === 'flagged'
        ? { handback: agentResult.handback, ...subagentHandbackReport({ ...agentResult, handback: agentResult.handback }) }
        : undefined
      if (ownWork && shouldNotifyOwner?.() !== false) enqueueAgentNotification({
        taskId,
        description,
        status: 'completed',
        waiting: true,
        setAppState: rootSetAppState,
        finalMessage: subagentResultText(agentResult),
        turnLimit: agentResult.turnLimit,
        // A report already delivered shows as one while the agent waits; a withheld one is not a report yet.
        ...(delivered && { handback: delivered.handback, handbackReport: {
          text: delivered.text,
          ...(delivered.warning && { warning: delivered.warning }),
          ...(agentResult.handbackToolUseId !== undefined && { toolUseId: agentResult.handbackToolUseId }),
        } }),
        usage: {
          totalTokens: finalProgress.tokenCount,
          toolUses: finalProgress.toolUseCount,
          durationMs: agentResult.totalDurationMs,
        },
        toolUseId: toolUseContext.toolUseId,
      })
      return
    }
    killOwnShells()

    let worktreeResult: Awaited<ReturnType<typeof getWorktreeResult>> = {}
    let worktreeWarning: string | undefined
    try {
      worktreeResult = await getWorktreeResult()
    } catch (error) {
      logForDebugging(
        `Agent worktree post-processing failed after completion: ${errorMessage(error)}`,
        { level: 'warn' },
      )
      addAgentTaskWarning(taskId, postProcessingWarning, rootSetAppState)
      worktreeWarning = postProcessingWarning
    }

    await end({
      taskId,
      description,
      status: 'completed',
      setAppState: rootSetAppState,
      turnLimit: agentResult.turnLimit,
      usage: {
        totalTokens: finalProgress.tokenCount,
        toolUses: finalProgress.toolUseCount,
        durationMs: agentResult.totalDurationMs,
      },
      toolUseId: toolUseContext.toolUseId,
      ...worktreeResult,
    }, report, answer => reportedAgentMessage(agentResult, answer, worktreeWarning))
  } catch (error) {
    onRunSettled?.()
    stopSummarization?.()
    killOwnShells()
    const currentTask = toolUseContext.getAppState().tasks[taskId]
    if (isLocalAgentTask(currentTask) && currentTask.status === 'completed') {
      logForDebugging(
        `Agent post-processing failed after completion: ${errorMessage(error)}`,
        { level: 'warn' },
      )
      addAgentTaskWarning(taskId, postProcessingWarning, rootSetAppState)
      // The report itself may be what failed: tell the parent without it.
      if (shouldNotifyOwner?.() !== false) enqueueAgentNotification({
        taskId,
        description,
        status: 'completed',
        setAppState: rootSetAppState,
        finalMessage: postProcessingWarning,
        toolUseId: toolUseContext.toolUseId,
      })
      return
    }
    if (isAbortError(error)) {
      // killAsyncAgent is a no-op if TaskStop already set status='killed' —
      // but only this catch handler has agentMessages, so the notification
      // must fire unconditionally. Transition status BEFORE worktree cleanup
      // so TaskOutput unblocks even if git hangs (gh-20236).
      // Official 2.1.329 counts an abort nothing else claimed as the user's.
      killAsyncAgent(taskId, rootSetAppState, 'system', 'user')
      logEvent('tengu_agent_tool_terminated', {
        agent_type:
          metadata.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        model:
          metadata.resolvedAgentModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        duration_ms: Date.now() - metadata.startTime,
        is_async: true,
        is_built_in_agent: metadata.isBuiltInAgent,
        reason:
          'user_kill_async' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      refreshLastAssistantProgress(
        tracker,
        agentMessages,
        resolveActivity,
        toolUseContext.options.tools,
      )
      let worktreeResult: Awaited<ReturnType<typeof getWorktreeResult>> = {}
      try {
        worktreeResult = await getWorktreeResult()
      } catch (cleanupError) {
        logForDebugging(
          `Agent worktree post-processing failed after kill: ${errorMessage(cleanupError)}`,
          { level: 'warn' },
        )
        addAgentTaskWarning(taskId, postProcessingWarning, rootSetAppState)
      }
      await end({
        taskId,
        description,
        status: 'killed',
        setAppState: rootSetAppState,
        toolUseId: toolUseContext.toolUseId,
        // Official 2.1.329 sends a stopped run's notice without <usage>.
        ...worktreeResult,
      }, unreviewedAgentReport(extractPartialResult(agentMessages) ?? '', toolUseContext), answer => answer.text || undefined)
      return
    }
    const msg = errorMessage(error)
    failAsyncAgent(taskId, msg, rootSetAppState)
    refreshLastAssistantProgress(
      tracker,
      agentMessages,
      resolveActivity,
      toolUseContext.options.tools,
    )
    let worktreeResult: Awaited<ReturnType<typeof getWorktreeResult>> = {}
    try {
      worktreeResult = await getWorktreeResult()
    } catch (cleanupError) {
      logForDebugging(
        `Agent worktree post-processing failed after failure: ${errorMessage(cleanupError)}`,
        { level: 'warn' },
      )
      addAgentTaskWarning(taskId, postProcessingWarning, rootSetAppState)
    }
    await end({
      taskId,
      description,
      status: 'failed',
      error: msg,
      setAppState: rootSetAppState,
      toolUseId: toolUseContext.toolUseId,
      // Official 2.1.329 sends a failed run's notice without <usage>.
      ...worktreeResult,
    }, unreviewedAgentReport('', toolUseContext), answer => answer.text || undefined)
  } finally {
    onRunSettled?.()
    clearInvokedSkillsForAgent(agentIdForCleanup)
    clearDumpState(agentIdForCleanup)
  }
}
