import { feature } from 'bun:bundle'
import type { Anthropic } from '@anthropic-ai/sdk'
import {
  getSystemPrompt,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from 'src/constants/prompts.js'
import { microcompactMessages } from 'src/services/compact/microCompact.js'
import { getCommandName } from '../commands.js'
import { getInitialSettings } from './settings/settings.js'
import { getSystemContext } from '../context.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  AUTOCOMPACT_BUFFER_TOKENS,
  getEffectiveContextWindowSize,
  isAutoCompactEnabled,
  MANUAL_COMPACT_BUFFER_TOKENS,
} from '../services/compact/autoCompact.js'
import {
  countMessagesTokensWithAPI,
  roughTokenCountEstimation,
  roughTokenCountEstimationForMessages,
} from '../services/tokenEstimation.js'
import { estimateSkillFrontmatterTokens } from '../skills/loadSkillsDir.js'
import {
  findToolByName,
  type Tool,
  type ToolPermissionContext,
  type Tools,
  type ToolUseContext,
  toolMatchesName,
} from '../Tool.js'
import type {
  AgentDefinition,
  AgentDefinitionsResult,
} from '../tools/AgentTool/loadAgentsDir.js'
import { SKILL_TOOL_NAME } from '../tools/SkillTool/constants.js'
import {
  getLimitedSkillToolCommands,
  getSkillToolInfo as getSlashCommandInfo,
} from '../tools/SkillTool/prompt.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  NormalizedAssistantMessage,
  NormalizedUserMessage,
  UserMessage,
} from '../types/message.js'
import { toolToAPISchema } from './api.js'
import { filterInjectedMemoryFiles, getMemoryFiles } from './claudemd.js'
import {
  type ContextWindowSource,
  resolveContextWindow,
} from './context.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import { errorMessage, toError } from './errors.js'
import { logError } from './log.js'
import { normalizeMessagesForAPI } from './messages.js'
import { getRuntimeMainLoopModel } from './model/model.js'
import type { SettingSource } from './settings/constants.js'
import { jsonStringify } from './slowOperations.js'
import {
  buildEffectiveSystemPrompt,
  getSystemPromptSections,
  withSystemPromptSections,
  type SystemPrompt,
} from './systemPrompt.js'
import type { Theme } from './theme.js'
import { getCurrentUsage, getTokenUsage } from './tokens.js'
import { extractDiscoveredToolNames } from './toolSearch.js'
import { isAnt } from 'src/utils/userType.js'


const RESERVED_CATEGORY_NAME = 'Autocompact buffer'
const MANUAL_COMPACT_BUFFER_NAME = 'Compact buffer'

/**
 * Fixed token overhead added by the API when tools are present.
 * The API adds a tool prompt preamble (~500 tokens) once per API call when tools are present.
 * When we count tools individually via the token counting API, each call includes this overhead,
 * leading to N × overhead instead of 1 × overhead for N tools.
 * We subtract this overhead from per-tool counts to show accurate tool content sizes.
 */
export const TOOL_TOKEN_COUNT_OVERHEAD = 500

export type ContextBreakdownDetail = 'summary' | 'full'

async function countTokens(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
  tools: Anthropic.Beta.Messages.BetaToolUnion[],
  model: string,
  detail: ContextBreakdownDetail,
  signal?: AbortSignal,
): Promise<number> {
  signal?.throwIfAborted()
  const localEstimate = () =>
    roughTokenCountEstimation(
      jsonStringify({
        messages:
          messages.length > 0 ? messages : [{ role: 'user', content: 'foo' }],
        tools,
      }),
    ) + (tools.length > 0 ? TOOL_TOKEN_COUNT_OVERHEAD : 0)

  if (detail === 'summary') {
    return localEstimate()
  }

  try {
    const result = await countMessagesTokensWithAPI(messages, tools, model, signal)
    signal?.throwIfAborted()
    if (result !== null) {
      return result
    }
    logForDebugging(
      `countTokens: API returned null, using local estimate (${tools.length} tools)`,
    )
  } catch (err) {
    signal?.throwIfAborted()
    logForDebugging(`countTokens: API failed, using local estimate: ${errorMessage(err)}`)
    logError(err)
  }

  return localEstimate()
}

export interface ContextCategory {
  name: string
  tokens: number
  color: keyof Theme
  isDeferred: boolean
  kind: 'used' | 'free' | 'buffer' | 'deferred'
}

interface GridSquare {
  color: keyof Theme
  isFilled: boolean
  categoryName: string
  tokens: number
  percentage: number
  squareFullness: number // 0-1 representing how full this individual square is
}

interface MemoryFile {
  path: string
  type: string
  tokens: number
}

interface McpTool {
  name: string
  serverName: string
  tokens: number
  isLoaded: boolean
}

export interface DeferredBuiltinTool {
  name: string
  tokens: number
  isLoaded: boolean
}

export interface SystemToolDetail {
  name: string
  tokens: number
}

export interface SystemPromptSectionDetail {
  name: string
  tokens: number
}

interface Agent {
  agentType: string
  source: SettingSource | 'built-in' | 'plugin'
  tokens: number
}

interface SlashCommandInfo {
  readonly totalCommands: number
  readonly includedCommands: number
  readonly tokens: number
}

/** Individual skill detail for context display */
interface SkillFrontmatter {
  name: string
  source: SettingSource | 'plugin'
  tokens: number
}

/**
 * Information about skills included in the context window.
 */
interface SkillInfo {
  /** Total number of available skills */
  readonly totalSkills: number
  /** Number of skills included within token budget */
  readonly includedSkills: number
  /** Total tokens consumed by skills */
  readonly tokens: number
  /** Individual skill details */
  readonly skillFrontmatter: SkillFrontmatter[]
}

export interface ContextData {
  readonly categories: ContextCategory[]
  readonly totalTokens: number
  readonly maxTokens: number
  readonly rawMaxTokens: number
  readonly autocompactSource: ContextWindowSource
  readonly percentage: number
  readonly gridRows: GridSquare[][]
  readonly model: string
  readonly memoryFiles: MemoryFile[]
  readonly mcpTools: McpTool[]
  /** Ant-only: per-tool breakdown of deferred built-in tools */
  readonly deferredBuiltinTools?: DeferredBuiltinTool[]
  /** Ant-only: per-tool breakdown of always-loaded built-in tools */
  readonly systemTools?: SystemToolDetail[]
  /** Ant-only: per-section breakdown of system prompt */
  readonly systemPromptSections?: SystemPromptSectionDetail[]
  readonly agents: Agent[]
  readonly slashCommands?: SlashCommandInfo
  /** Skill statistics */
  readonly skills?: SkillInfo
  readonly autoCompactThreshold?: number
  readonly isAutoCompactEnabled: boolean
  messageBreakdown?: {
    toolCallTokens: number
    toolResultTokens: number
    attachmentTokens: number
    assistantMessageTokens: number
    userMessageTokens: number
    toolCallsByType: Array<{
      name: string
      callTokens: number
      resultTokens: number
    }>
    attachmentsByType: Array<{ name: string; tokens: number }>
  }
  /** Actual token usage from last API response (if available) */
  readonly apiUsage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  } | null
}

export function getLoadedDeferredToolNames(
  tools: Tools,
  messages?: Message[],
): Set<string> {
  if (!messages) return new Set()
  const toolNames = new Set(tools.map(tool => tool.name))
  return new Set(
    [...extractDiscoveredToolNames(messages)].filter(name =>
      toolNames.has(name),
    ),
  )
}

export function estimateToolSchemaTokenAllocation(
  schemas: readonly Anthropic.Beta.Messages.BetaToolUnion[],
  distributableTokens: number,
  excludedNames: ReadonlySet<string> = new Set(),
): SystemToolDetail[] {
  const estimates = schemas.map(schema =>
    roughTokenCountEstimation(jsonStringify(schema)),
  )
  const estimateTotal =
    estimates.reduce((sum, estimate) => sum + estimate, 0) || 1

  return schemas
    .flatMap((schema, index) =>
      'name' in schema
        ? [
            {
              name: schema.name,
              tokens: Math.round(
                (estimates[index]! / estimateTotal) * distributableTokens,
              ),
            },
          ]
        : [],
    )
    .filter(detail => !excludedNames.has(detail.name))
    .sort((a, b) => b.tokens - a.tokens)
}

export async function countToolSchemaTokens(
  schemas: readonly Anthropic.Beta.Messages.BetaToolUnion[],
  model: string,
  detail: ContextBreakdownDetail,
  signal?: AbortSignal,
): Promise<SystemToolDetail[]> {
  const tokenCounts = await Promise.all(
    schemas.map(schema => countTokens([], [schema], model, detail, signal)),
  )

  return schemas.flatMap((schema, index) =>
    'name' in schema
      ? [
          {
            name: schema.name,
            tokens: Math.max(
              0,
              tokenCounts[index]! - TOOL_TOKEN_COUNT_OVERHEAD,
            ),
          },
        ]
      : [],
  )
}

export async function countToolDefinitionTokens(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agentInfo: AgentDefinitionsResult | null,
  model: string,
  detail: ContextBreakdownDetail = 'full',
  signal?: AbortSignal,
): Promise<number> {
  const toolSchemas = await Promise.all(
    tools.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext,
        tools,
        agents: agentInfo?.activeAgents ?? [],
        model,
      }),
    ),
  )
  if (toolSchemas.length === 0) {
    return 0
  }

  const toolDetails = await countToolSchemaTokens(
    toolSchemas,
    model,
    detail,
    signal,
  )
  return (
    toolDetails.reduce((sum, tool) => sum + tool.tokens, 0) +
    TOOL_TOKEN_COUNT_OVERHEAD
  )
}

/** Extract a human-readable name from a system prompt section's content */
function extractSectionName(content: string): string {
  // Try to find first markdown heading
  const headingMatch = content.match(/^#+\s+(.+)$/m)
  if (headingMatch) {
    return headingMatch[1]!.trim()
  }
  // Fall back to a truncated preview of the first non-empty line
  const firstLine = content.split('\n').find(l => l.trim().length > 0) ?? ''
  return firstLine.length > 40 ? firstLine.slice(0, 40) + '…' : firstLine
}

export function getNamedSystemPromptEntries(
  effectiveSystemPrompt: SystemPrompt,
): Array<{ name: string; content: string }> {
  const sections = getSystemPromptSections(effectiveSystemPrompt)
  if (sections) {
    return sections.flatMap(section => {
      if ('sections' in section) {
        const content = withSystemPromptSections(section.sections).join(
          section.separator,
        )
        return [{ name: extractSectionName(content), content }]
      }
      return section.text === null
        ? []
        : [
            {
              name:
                'name' in section
                  ? section.name
                  : extractSectionName(section.text),
              content: section.text,
            },
          ]
    })
  }

  return effectiveSystemPrompt
    .filter(
      content =>
        content.length > 0 && content !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    )
    .map(content => ({ name: extractSectionName(content), content }))
}

async function countSystemTokens(
  effectiveSystemPrompt: SystemPrompt,
  model: string,
  detail: ContextBreakdownDetail,
  signal?: AbortSignal,
): Promise<{
  systemPromptTokens: number
  systemPromptSections: SystemPromptSectionDetail[]
}> {
  // Get system context (gitStatus, etc.) which is always included
  const systemContext = await getSystemContext()

  // Build named entries: system prompt parts + system context values
  // Skip empty strings and the global-cache boundary marker
  // @ts-ignore - recovered code
  const namedEntries: Array<{ name: string; content: string }> = [
    ...getNamedSystemPromptEntries(effectiveSystemPrompt),
    ...Object.entries(systemContext)
      // @ts-ignore - recovered code
      .filter(([, content]) => content.length > 0)
      .map(([name, content]) => ({ name, content })),
  ]

  if (namedEntries.length < 1) {
    return { systemPromptTokens: 0, systemPromptSections: [] }
  }

  const systemTokenCounts = await Promise.all(
    namedEntries.map(({ content }) =>
      countTokens([{ role: 'user', content }], [], model, detail, signal),
    ),
  )

  const systemPromptSections: SystemPromptSectionDetail[] = namedEntries.map(
    (entry, i) => ({
      name: entry.name,
      tokens: systemTokenCounts[i] || 0,
    }),
  )

  const systemPromptTokens = systemTokenCounts.reduce(
    (sum: number, tokens) => sum + (tokens || 0),
    0,
  )

  return { systemPromptTokens, systemPromptSections }
}

async function countMemoryFileTokens(
  model: string,
  detail: ContextBreakdownDetail,
  signal?: AbortSignal,
): Promise<{
  memoryFileDetails: MemoryFile[]
  claudeMdTokens: number
}> {
  // Simple mode disables CLAUDE.md loading, so don't report tokens for them
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    return { memoryFileDetails: [], claudeMdTokens: 0 }
  }

  const memoryFilesData = filterInjectedMemoryFiles(await getMemoryFiles())
  const memoryFileDetails: MemoryFile[] = []
  let claudeMdTokens = 0

  if (memoryFilesData.length < 1) {
    return {
      memoryFileDetails: [],
      claudeMdTokens: 0,
    }
  }

  const claudeMdTokenCounts = await Promise.all(
    memoryFilesData.map(async file => {
      const tokens = await countTokens(
        [{ role: 'user', content: file.content }],
        [],
        model,
        detail,
        signal,
      )

      return { file, tokens: tokens || 0 }
    }),
  )

  for (const { file, tokens } of claudeMdTokenCounts) {
    claudeMdTokens += tokens
    memoryFileDetails.push({
      path: file.path,
      type: file.type,
      tokens,
    })
  }

  return { claudeMdTokens, memoryFileDetails }
}

async function countBuiltInToolTokens(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agentInfo: AgentDefinitionsResult | null,
  model: string,
  messages?: Message[],
  detail: ContextBreakdownDetail = 'full',
  signal?: AbortSignal,
): Promise<{
  builtInToolTokens: number
  deferredBuiltinDetails: DeferredBuiltinTool[]
  deferredBuiltinTokens: number
  systemToolDetails: SystemToolDetail[]
}> {
  const builtInTools = tools.filter(tool => !tool.isMcp)
  if (builtInTools.length < 1) {
    return {
      builtInToolTokens: 0,
      deferredBuiltinDetails: [],
      deferredBuiltinTokens: 0,
      systemToolDetails: [],
    }
  }

  // Check if tool search is enabled
  const { isToolSearchEnabled } = await import('./toolSearch.js')
  const { isDeferredTool } = await import('../tools/ToolSearchTool/prompt.js')
  const isDeferred = await isToolSearchEnabled(
    model ?? '',
    tools,
    getToolPermissionContext,
    agentInfo?.activeAgents ?? [],
    'analyzeBuiltIn',
  )

  // Separate always-loaded and deferred builtin tools using dynamic isDeferredTool check
  const alwaysLoadedTools = builtInTools.filter(t => !isDeferredTool(t))
  const deferredBuiltinTools = builtInTools.filter(t => isDeferredTool(t))

  // Count always-loaded tools
  const alwaysLoadedTokens =
    alwaysLoadedTools.length > 0
      ? await countToolDefinitionTokens(
          alwaysLoadedTools,
          getToolPermissionContext,
          agentInfo,
          model,
          detail,
          signal,
        )
      : 0

  // Build per-tool breakdown for always-loaded tools (ant-only), weighted by
  // the exact production schema shape. Skill remains part of the denominator
  // so excluding it here does not reallocate its tokens to other tools.
  let systemToolDetails: SystemToolDetail[] = []
  if (isAnt() && alwaysLoadedTools.length > 0) {
    const schemas = await Promise.all(
      alwaysLoadedTools.map(tool =>
        toolToAPISchema(tool, {
          getToolPermissionContext,
          tools,
          agents: agentInfo?.activeAgents ?? [],
          model,
        }),
      ),
    )
    systemToolDetails = estimateToolSchemaTokenAllocation(
      schemas,
      Math.max(0, alwaysLoadedTokens - TOOL_TOKEN_COUNT_OVERHEAD),
      new Set(
        alwaysLoadedTools
          .filter(tool => toolMatchesName(tool, SKILL_TOOL_NAME))
          .map(tool => tool.name),
      ),
    )
  }

  // Count deferred builtin tools individually for details
  const deferredBuiltinDetails: DeferredBuiltinTool[] = []
  let loadedDeferredTokens = 0
  let totalDeferredTokens = 0

  if (deferredBuiltinTools.length > 0 && isDeferred) {
    const loadedToolNames = getLoadedDeferredToolNames(
      deferredBuiltinTools,
      messages,
    )

    // Count each deferred tool
    const tokensByTool = await Promise.all(
      deferredBuiltinTools.map(t =>
        countToolDefinitionTokens(
          [t],
          getToolPermissionContext,
          agentInfo,
          model,
          detail,
          signal,
        ),
      ),
    )

    for (const [i, tool] of deferredBuiltinTools.entries()) {
      const tokens = Math.max(
        0,
        (tokensByTool[i] || 0) - TOOL_TOKEN_COUNT_OVERHEAD,
      )
      const isLoaded = loadedToolNames.has(tool.name)
      deferredBuiltinDetails.push({
        name: tool.name,
        tokens,
        isLoaded,
      })
      totalDeferredTokens += tokens
      if (isLoaded) {
        loadedDeferredTokens += tokens
      }
    }
  } else if (deferredBuiltinTools.length > 0) {
    // Tool search not enabled - count deferred tools as regular
    const deferredTokens = await countToolDefinitionTokens(
      deferredBuiltinTools,
      getToolPermissionContext,
      agentInfo,
      model,
      detail,
      signal,
    )
    return {
      builtInToolTokens: alwaysLoadedTokens + deferredTokens,
      deferredBuiltinDetails: [],
      deferredBuiltinTokens: 0,
      systemToolDetails,
    }
  }

  return {
    // When deferred, only count always-loaded tools + any loaded deferred tools
    builtInToolTokens: alwaysLoadedTokens + loadedDeferredTokens,
    deferredBuiltinDetails,
    deferredBuiltinTokens: totalDeferredTokens - loadedDeferredTokens,
    systemToolDetails,
  }
}

function findSkillTool(tools: Tools): Tool | undefined {
  return findToolByName(tools, SKILL_TOOL_NAME)
}

async function countSlashCommandTokens(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agentInfo: AgentDefinitionsResult | null,
  model: string,
  detail: ContextBreakdownDetail,
  signal?: AbortSignal,
): Promise<{
  slashCommandTokens: number
  commandInfo: { totalCommands: number; includedCommands: number }
}> {
  const info = await getSlashCommandInfo(getCwd())

  const slashCommandTool = findSkillTool(tools)
  if (!slashCommandTool) {
    return {
      slashCommandTokens: 0,
      commandInfo: { totalCommands: 0, includedCommands: 0 },
    }
  }

  const slashCommandTokens = await countToolDefinitionTokens(
    [slashCommandTool],
    getToolPermissionContext,
    agentInfo,
    model,
    detail,
    signal,
  )

  return {
    slashCommandTokens,
    commandInfo: {
      totalCommands: info.totalCommands,
      includedCommands: info.includedCommands,
    },
  }
}

async function countSkillTokens(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agentInfo: AgentDefinitionsResult | null,
  model: string,
  detail: ContextBreakdownDetail,
  signal?: AbortSignal,
): Promise<{
  skillTokens: number
  skillInfo: {
    totalSkills: number
    includedSkills: number
    skillFrontmatter: SkillFrontmatter[]
  }
}> {
  try {
    const skills = await getLimitedSkillToolCommands(getCwd())

    const slashCommandTool = findSkillTool(tools)
    if (!slashCommandTool) {
      return {
        skillTokens: 0,
        skillInfo: { totalSkills: 0, includedSkills: 0, skillFrontmatter: [] },
      }
    }

    // NOTE: This counts the entire SlashCommandTool (which includes both commands AND skills).
    // This is the same tool counted by countSlashCommandTokens(), but we track it separately
    // here for display purposes. These tokens should NOT be added to context categories
    // to avoid double-counting.
    const skillTokens = await countToolDefinitionTokens(
      [slashCommandTool],
      getToolPermissionContext,
      agentInfo,
      model,
      detail,
      signal,
    )

    // Calculate per-skill token estimates based on frontmatter only
    // (name, description, whenToUse) since full content is only loaded on invocation
    const skillFrontmatter: SkillFrontmatter[] = skills.map(skill => ({
      name: getCommandName(skill),
      source: (skill.type === 'prompt' ? skill.source : 'plugin') as
        | SettingSource
        | 'plugin',
      tokens: estimateSkillFrontmatterTokens(skill),
    }))

    return {
      skillTokens,
      skillInfo: {
        totalSkills: skills.length,
        includedSkills: skills.length,
        skillFrontmatter,
      },
    }
  } catch (error) {
    signal?.throwIfAborted()
    logError(toError(error))

    // Return zero values rather than failing the entire context analysis
    return {
      skillTokens: 0,
      skillInfo: { totalSkills: 0, includedSkills: 0, skillFrontmatter: [] },
    }
  }
}

export async function countMcpToolTokens(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agentInfo: AgentDefinitionsResult | null,
  model: string,
  messages?: Message[],
  detail: ContextBreakdownDetail = 'full',
  signal?: AbortSignal,
): Promise<{
  mcpToolTokens: number
  mcpToolDetails: McpTool[]
  deferredToolTokens: number
  loadedMcpToolNames: Set<string>
}> {
  const mcpTools = tools.filter(tool => tool.isMcp)
  const mcpToolDetails: McpTool[] = []
  const schemas = await Promise.all(
    mcpTools.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext,
        tools,
        agents: agentInfo?.activeAgents ?? [],
        model,
      }),
    ),
  )
  const mcpToolTokensByTool = await countToolSchemaTokens(
    schemas,
    model,
    detail,
    signal,
  )
  const totalTokens = mcpToolTokensByTool.reduce(
    (sum, tool) => sum + tool.tokens,
    0,
  )

  // Check if tool search is enabled - if so, MCP tools are deferred
  // isToolSearchEnabled handles threshold calculation internally for TstAuto mode
  const { isToolSearchEnabled } = await import('./toolSearch.js')
  const { isDeferredTool } = await import('../tools/ToolSearchTool/prompt.js')

  const isDeferred = await isToolSearchEnabled(
    model,
    tools,
    getToolPermissionContext,
    agentInfo?.activeAgents ?? [],
    'analyzeMcp',
  )

  const loadedMcpToolNames = isDeferred
    ? getLoadedDeferredToolNames(mcpTools, messages)
    : new Set<string>()

  // Build tool details with isLoaded flag
  for (const [i, tool] of mcpTools.entries()) {
    mcpToolDetails.push({
      name: tool.name,
      serverName: tool.name.split('__')[1] || 'unknown',
      tokens: mcpToolTokensByTool[i]!.tokens,
      isLoaded: loadedMcpToolNames.has(tool.name) || !isDeferredTool(tool),
    })
  }

  // Calculate loaded vs deferred tokens
  let loadedTokens = 0
  let deferredTokens = 0
  for (const detail of mcpToolDetails) {
    if (detail.isLoaded) {
      loadedTokens += detail.tokens
    } else if (isDeferred) {
      deferredTokens += detail.tokens
    }
  }

  return {
    // When deferred but some tools are loaded, count loaded tokens
    mcpToolTokens: isDeferred ? loadedTokens : totalTokens,
    mcpToolDetails,
    // Track deferred tokens separately for display
    deferredToolTokens: deferredTokens,
    loadedMcpToolNames,
  }
}

async function countCustomAgentTokens(
  agentDefinitions: { activeAgents: AgentDefinition[] },
  model: string,
  detail: ContextBreakdownDetail,
  signal?: AbortSignal,
): Promise<{
  agentTokens: number
  agentDetails: Agent[]
}> {
  const customAgents = agentDefinitions.activeAgents.filter(
    a => a.source !== 'built-in',
  )
  const agentDetails: Agent[] = []
  let agentTokens = 0

  const tokenCounts = await Promise.all(
    customAgents.map(agent =>
      countTokens(
        [
          {
            role: 'user',
            content: [agent.agentType, agent.whenToUse].join(' '),
          },
        ],
        [],
        model,
        detail,
        signal,
      ),
    ),
  )

  for (const [i, agent] of customAgents.entries()) {
    const tokens = tokenCounts[i] || 0
    agentTokens += tokens || 0
    agentDetails.push({
      agentType: agent.agentType,
      source: agent.source,
      tokens: tokens || 0,
    })
  }
  return { agentTokens, agentDetails }
}

type MessageBreakdown = {
  totalTokens: number
  toolCallTokens: number
  toolResultTokens: number
  attachmentTokens: number
  assistantMessageTokens: number
  userMessageTokens: number
  toolCallsByType: Map<string, number>
  toolResultsByType: Map<string, number>
  attachmentsByType: Map<string, number>
}

function processAssistantMessage(
  msg: AssistantMessage | NormalizedAssistantMessage,
  breakdown: MessageBreakdown,
): void {
  // Process each content block individually
  for (const block of msg.message.content) {
    const blockStr = jsonStringify(block)
    const blockTokens = roughTokenCountEstimation(blockStr)

    if ('type' in block && block.type === 'tool_use') {
      breakdown.toolCallTokens += blockTokens
      const toolName = ('name' in block ? block.name : undefined) || 'unknown'
      breakdown.toolCallsByType.set(
        // @ts-ignore - recovered code
        toolName,
        // @ts-ignore - recovered code
        (breakdown.toolCallsByType.get(toolName) || 0) + blockTokens,
      )
    } else {
      // Text blocks or other non-tool content
      breakdown.assistantMessageTokens += blockTokens
    }
  }
}

function processUserMessage(
  msg: UserMessage | NormalizedUserMessage,
  breakdown: MessageBreakdown,
  toolUseIdToName: Map<string, string>,
): void {
  // Handle both string and array content
  if (typeof msg.message.content === 'string') {
    // Simple string content
    const tokens = roughTokenCountEstimation(msg.message.content)
    breakdown.userMessageTokens += tokens
    return
  }

  // Process each content block individually
  for (const block of msg.message.content) {
    const blockStr = jsonStringify(block)
    const blockTokens = roughTokenCountEstimation(blockStr)

    if ('type' in block && block.type === 'tool_result') {
      breakdown.toolResultTokens += blockTokens
      const toolUseId = 'tool_use_id' in block ? block.tool_use_id : undefined
      const toolName =
        // @ts-ignore - recovered code
        (toolUseId ? toolUseIdToName.get(toolUseId) : undefined) || 'unknown'
      breakdown.toolResultsByType.set(
        toolName,
        (breakdown.toolResultsByType.get(toolName) || 0) + blockTokens,
      )
    } else {
      // Text blocks or other non-tool content
      breakdown.userMessageTokens += blockTokens
    }
  }
}

function processAttachment(
  msg: AttachmentMessage,
  breakdown: MessageBreakdown,
): void {
  const contentStr = jsonStringify(msg.attachment)
  const tokens = roughTokenCountEstimation(contentStr)
  breakdown.attachmentTokens += tokens
  // @ts-ignore - recovered code
  const attachType = msg.attachment.type || 'unknown'
  breakdown.attachmentsByType.set(
    attachType,
    (breakdown.attachmentsByType.get(attachType) || 0) + tokens,
  )
}

async function approximateMessageTokens(
  messages: Message[],
  model: string,
  detail: ContextBreakdownDetail,
  signal?: AbortSignal,
): Promise<MessageBreakdown> {
  const microcompactResult = await microcompactMessages(messages)

  // Initialize tracking
  const breakdown: MessageBreakdown = {
    totalTokens: 0,
    toolCallTokens: 0,
    toolResultTokens: 0,
    attachmentTokens: 0,
    assistantMessageTokens: 0,
    userMessageTokens: 0,
    toolCallsByType: new Map<string, number>(),
    toolResultsByType: new Map<string, number>(),
    attachmentsByType: new Map<string, number>(),
  }

  // Build a map of tool_use_id to tool_name for easier lookup
  const toolUseIdToName = new Map<string, string>()
  for (const msg of microcompactResult.messages) {
    if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if ('type' in block && block.type === 'tool_use') {
          const toolUseId = 'id' in block ? block.id : undefined
          const toolName =
            ('name' in block ? block.name : undefined) || 'unknown'
          if (toolUseId) {
            // @ts-ignore - recovered code
            toolUseIdToName.set(toolUseId, toolName)
          }
        }
      }
    }
  }

  // Process each message for detailed breakdown
  for (const msg of microcompactResult.messages) {
    if (msg.type === 'assistant') {
      processAssistantMessage(msg, breakdown)
    } else if (msg.type === 'user') {
      processUserMessage(msg, breakdown, toolUseIdToName)
    } else if (msg.type === 'attachment') {
      processAttachment(msg, breakdown)
    }
  }

  const normalizedMessages = normalizeMessagesForAPI(
    microcompactResult.messages,
  ).map(_ => {
    if (_.type === 'assistant') {
      return {
        // Important: strip out fields like id, etc. -- the counting API errors if they're present
        role: 'assistant' as const,
        content: _.message.content,
      }
    }
    return _.message
  })
  const approximateMessageTokens =
    detail === 'summary'
      ? roughTokenCountEstimationForMessages(
          microcompactResult.messages as Parameters<
            typeof roughTokenCountEstimationForMessages
          >[0],
        )
      : await countTokens(
          normalizedMessages as Anthropic.Beta.Messages.BetaMessageParam[],
          [],
          model,
          detail,
          signal,
        )

  breakdown.totalTokens = approximateMessageTokens ?? 0
  return breakdown
}

function getAssistantMessageId(message: Message): string | undefined {
  if (
    message.type === 'assistant' &&
    'id' in message.message &&
    typeof message.message.id === 'string'
  ) {
    return message.message.id
  }
  return undefined
}

function estimateTokensAfterLastApiUsage(messages: Message[]): number {
  let anchorIndex = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message || !getTokenUsage(message)) continue

    anchorIndex = index
    const messageId = getAssistantMessageId(message)
    if (messageId) {
      for (let previous = index - 1; previous >= 0; previous--) {
        const previousId = getAssistantMessageId(messages[previous]!)
        if (previousId === messageId) {
          anchorIndex = previous
        } else if (previousId !== undefined) {
          break
        }
      }
    }
    break
  }

  return roughTokenCountEstimationForMessages(
    messages
      .slice(anchorIndex + 1)
      .filter(message => message.type !== 'attachment') as Parameters<
      typeof roughTokenCountEstimationForMessages
    >[0],
  )
}

export interface BuildContextUsageDataInput {
  model: string
  contextWindow: number
  autocompactSource: ContextWindowSource
  terminalWidth?: number
  isAutoCompact: boolean
  systemPromptTokens: number
  claudeMdTokens: number
  builtInToolTokens: number
  mcpToolTokens: number
  deferredToolTokens: number
  deferredBuiltinTokens: number
  agentTokens: number
  slashCommandTokens: number
  skillFrontmatterTokens: number
  memoryFileDetails: MemoryFile[]
  mcpToolDetails: McpTool[]
  deferredBuiltinDetails: DeferredBuiltinTool[]
  systemToolDetails: SystemToolDetail[]
  systemPromptSections: SystemPromptSectionDetail[]
  agentDetails: Agent[]
  commandInfo: { totalCommands: number; includedCommands: number }
  skillInfo: {
    totalSkills: number
    includedSkills: number
    skillFrontmatter: SkillFrontmatter[]
  }
  messageBreakdown: MessageBreakdown
  apiUsage: ContextData['apiUsage']
  estimatedTokensAfterLastApiUsage: number
  skipReservedBuffer: boolean
  autoCompactThreshold?: number
}

export function buildContextUsageData({
  model,
  contextWindow,
  autocompactSource,
  terminalWidth,
  isAutoCompact,
  systemPromptTokens,
  claudeMdTokens,
  builtInToolTokens,
  mcpToolTokens,
  deferredToolTokens,
  deferredBuiltinTokens,
  agentTokens,
  slashCommandTokens,
  skillFrontmatterTokens,
  memoryFileDetails,
  mcpToolDetails,
  deferredBuiltinDetails,
  systemToolDetails,
  systemPromptSections,
  agentDetails,
  commandInfo,
  skillInfo,
  messageBreakdown,
  apiUsage,
  estimatedTokensAfterLastApiUsage,
  skipReservedBuffer,
  autoCompactThreshold: resolvedAutoCompactThreshold,
}: BuildContextUsageDataInput): ContextData {
  const cats: ContextCategory[] = []
  const addCategory = (
    name: string,
    tokens: number,
    color: keyof Theme,
    kind: ContextCategory['kind'] = 'used',
  ) => {
    if (tokens > 0 || kind === 'free') {
      cats.push({
        name,
        tokens,
        color,
        kind,
        isDeferred: kind === 'deferred',
      })
    }
  }

  addCategory('System prompt', systemPromptTokens, 'promptBorder')
  addCategory(
    isAnt() ? '[ANT-ONLY] System tools' : 'System tools',
    builtInToolTokens - skillFrontmatterTokens,
    'inactive',
  )
  addCategory('MCP tools', mcpToolTokens, 'cyan_FOR_SUBAGENTS_ONLY')
  addCategory(
    'MCP tools (deferred)',
    deferredToolTokens,
    'inactive',
    'deferred',
  )
  addCategory(
    'System tools (deferred)',
    deferredBuiltinTokens,
    'inactive',
    'deferred',
  )
  addCategory('Custom agents', agentTokens, 'permission')
  addCategory('Memory files', claudeMdTokens, 'claude')
  addCategory('Skills', skillFrontmatterTokens, 'warning')

  let reservedTokens = 0
  let reservedName: typeof RESERVED_CATEGORY_NAME | typeof MANUAL_COMPACT_BUFFER_NAME | undefined
  const autoCompactThreshold = isAutoCompact
    ? (resolvedAutoCompactThreshold ??
      contextWindow - AUTOCOMPACT_BUFFER_TOKENS)
    : undefined
  if (
    !skipReservedBuffer &&
    isAutoCompact &&
    autocompactSource !== 'auto' &&
    autoCompactThreshold !== undefined
  ) {
    reservedTokens = Math.max(0, contextWindow - autoCompactThreshold)
    reservedName = RESERVED_CATEGORY_NAME
  } else if (!skipReservedBuffer && !isAutoCompact) {
    reservedTokens = MANUAL_COMPACT_BUFFER_TOKENS
    reservedName = MANUAL_COMPACT_BUFFER_NAME
  }

  const apiInputTokens = apiUsage
    ? apiUsage.input_tokens +
      apiUsage.cache_creation_input_tokens +
      apiUsage.cache_read_input_tokens
    : null
  const fixedTokens = cats.reduce(
    (sum, category) => sum + (category.isDeferred ? 0 : category.tokens),
    0,
  )
  const messageCapacity = Math.max(0, contextWindow - fixedTokens - reservedTokens)
  const reconciledMessageTokens =
    apiInputTokens === null
      ? messageBreakdown.totalTokens
      : Math.max(
          0,
          Math.min(
            Math.max(0, apiInputTokens - fixedTokens) +
              estimatedTokensAfterLastApiUsage,
            messageCapacity,
          ),
        )

  addCategory(
    'Messages',
    reconciledMessageTokens,
    'purple_FOR_SUBAGENTS_ONLY',
  )

  const usedTokens = cats.reduce(
    (sum, category) => sum + (category.isDeferred ? 0 : category.tokens),
    0,
  )
  if (reservedName) {
    addCategory(reservedName, reservedTokens, 'inactive', 'buffer')
  }
  addCategory(
    'Free space',
    Math.max(0, contextWindow - usedTokens - reservedTokens),
    'promptBorder',
    'free',
  )

  const totalTokens = apiInputTokens ?? usedTokens
  const isNarrowScreen = terminalWidth !== undefined && terminalWidth < 80
  const gridWidth =
    contextWindow >= 1_000_000
      ? isNarrowScreen
        ? 5
        : 20
      : isNarrowScreen
        ? 5
        : 10
  const gridHeight = contextWindow >= 1_000_000 ? 10 : isNarrowScreen ? 5 : 10
  const totalSquares = gridWidth * gridHeight
  const categorySquares = cats
    .filter(category => !category.isDeferred)
    .map(category => ({
      ...category,
      squares:
        category.kind === 'free'
          ? Math.round((category.tokens / contextWindow) * totalSquares)
          : Math.max(1, Math.round((category.tokens / contextWindow) * totalSquares)),
      percentageOfTotal: Math.round((category.tokens / contextWindow) * 100),
    }))

  const createSquares = (category: (typeof categorySquares)[number]): GridSquare[] => {
    const exactSquares = (category.tokens / contextWindow) * totalSquares
    const wholeSquares = Math.floor(exactSquares)
    const fractionalPart = exactSquares - wholeSquares
    return Array.from({ length: category.squares }, (_, index) => ({
      color: category.color,
      isFilled: true,
      categoryName: category.name,
      tokens: category.tokens,
      percentage: category.percentageOfTotal,
      squareFullness:
        index === wholeSquares && fractionalPart > 0 ? fractionalPart : 1,
    }))
  }

  const gridSquares: GridSquare[] = []
  const reservedCategory = categorySquares.find(category => category.kind === 'buffer')
  for (const category of categorySquares.filter(
    category => category.kind !== 'buffer' && category.kind !== 'free',
  )) {
    for (const square of createSquares(category)) {
      if (gridSquares.length < totalSquares) gridSquares.push(square)
    }
  }

  const freeSpace = cats.find(category => category.kind === 'free')!
  const freeSpaceTarget = totalSquares - (reservedCategory?.squares ?? 0)
  while (gridSquares.length < freeSpaceTarget) {
    gridSquares.push({
      color: freeSpace.color,
      isFilled: true,
      categoryName: freeSpace.name,
      tokens: freeSpace.tokens,
      percentage: Math.round((freeSpace.tokens / contextWindow) * 100),
      squareFullness: 1,
    })
  }
  if (reservedCategory) {
    for (const square of createSquares(reservedCategory)) {
      if (gridSquares.length < totalSquares) gridSquares.push(square)
    }
  }

  const gridRows = Array.from({ length: gridHeight }, (_, row) =>
    gridSquares.slice(row * gridWidth, (row + 1) * gridWidth),
  )
  const toolsMap = new Map<string, { callTokens: number; resultTokens: number }>()
  for (const [name, tokens] of messageBreakdown.toolCallsByType) {
    const existing = toolsMap.get(name) ?? { callTokens: 0, resultTokens: 0 }
    toolsMap.set(name, { ...existing, callTokens: tokens })
  }
  for (const [name, tokens] of messageBreakdown.toolResultsByType) {
    const existing = toolsMap.get(name) ?? { callTokens: 0, resultTokens: 0 }
    toolsMap.set(name, { ...existing, resultTokens: tokens })
  }

  return {
    categories: cats,
    totalTokens,
    maxTokens: contextWindow,
    rawMaxTokens: contextWindow,
    autocompactSource,
    percentage: Math.round((totalTokens / contextWindow) * 100),
    gridRows,
    model,
    memoryFiles: memoryFileDetails,
    mcpTools: mcpToolDetails.map(tool => ({
      ...tool,
      isLoaded: tool.isLoaded === true,
    })),
    deferredBuiltinTools: isAnt() ? deferredBuiltinDetails : undefined,
    systemTools: isAnt() ? systemToolDetails : undefined,
    systemPromptSections: isAnt() ? systemPromptSections : undefined,
    agents: agentDetails,
    slashCommands:
      slashCommandTokens > 0
        ? { ...commandInfo, tokens: slashCommandTokens }
        : undefined,
    skills:
      skillFrontmatterTokens > 0
        ? {
            ...skillInfo,
            tokens: skillFrontmatterTokens,
          }
        : undefined,
    autoCompactThreshold,
    isAutoCompactEnabled: isAutoCompact,
    messageBreakdown: {
      toolCallTokens: messageBreakdown.toolCallTokens,
      toolResultTokens: messageBreakdown.toolResultTokens,
      attachmentTokens: messageBreakdown.attachmentTokens,
      assistantMessageTokens: messageBreakdown.assistantMessageTokens,
      userMessageTokens: messageBreakdown.userMessageTokens,
      toolCallsByType: Array.from(toolsMap, ([name, tokens]) => ({
        name,
        ...tokens,
      })).sort(
        (a, b) => b.callTokens + b.resultTokens - (a.callTokens + a.resultTokens),
      ),
      attachmentsByType: Array.from(
        messageBreakdown.attachmentsByType,
        ([name, tokens]) => ({ name, tokens }),
      ).sort((a, b) => b.tokens - a.tokens),
    },
    apiUsage,
  }
}

export async function analyzeContextUsage(
  messages: Message[],
  model: string,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  tools: Tools,
  agentDefinitions: AgentDefinitionsResult,
  terminalWidth?: number,
  toolUseContext?: Pick<ToolUseContext, 'options'>,
  mainThreadAgentDefinition?: AgentDefinition,
  /** Original messages before microcompact, used to extract API usage */
  originalMessages?: Message[],
  analysisOptions: { detail?: ContextBreakdownDetail; signal?: AbortSignal } = {},
): Promise<ContextData> {
  const { signal } = analysisOptions
  signal?.throwIfAborted()
  const runtimeModel = getRuntimeMainLoopModel({
    permissionMode: (await getToolPermissionContext()).mode,
    mainLoopModel: model,
  })
  const { window: contextWindow, source: autocompactSource } =
    resolveContextWindow(runtimeModel, getInitialSettings().autoCompactWindow)
  const detail = analysisOptions.detail ?? 'full'

  const defaultSystemPrompt = await getSystemPrompt(tools, runtimeModel)
  const effectiveSystemPrompt = buildEffectiveSystemPrompt({
    mainThreadAgentDefinition,
    toolUseContext: toolUseContext ?? {
      options: {} as ToolUseContext['options'],
    },
    customSystemPrompt: toolUseContext?.options.customSystemPrompt,
    defaultSystemPrompt,
    appendSystemPrompt: toolUseContext?.options.appendSystemPrompt,
  })

  const [
    { systemPromptTokens, systemPromptSections },
    { claudeMdTokens, memoryFileDetails },
    {
      builtInToolTokens,
      deferredBuiltinDetails,
      deferredBuiltinTokens,
      systemToolDetails,
    },
    { mcpToolTokens, mcpToolDetails, deferredToolTokens },
    { agentTokens, agentDetails },
    { slashCommandTokens, commandInfo },
    messageBreakdown,
  ] = await Promise.all([
    countSystemTokens(effectiveSystemPrompt, runtimeModel, detail, signal),
    countMemoryFileTokens(runtimeModel, detail, signal),
    countBuiltInToolTokens(
      tools,
      getToolPermissionContext,
      agentDefinitions,
      runtimeModel,
      messages,
      detail,
      signal,
    ),
    countMcpToolTokens(
      tools,
      getToolPermissionContext,
      agentDefinitions,
      runtimeModel,
      messages,
      detail,
      signal,
    ),
    countCustomAgentTokens(agentDefinitions, runtimeModel, detail, signal),
    countSlashCommandTokens(
      tools,
      getToolPermissionContext,
      agentDefinitions,
      runtimeModel,
      detail,
      signal,
    ),
    approximateMessageTokens(messages, runtimeModel, detail, signal),
  ])

  const skillResult = await countSkillTokens(
    tools,
    getToolPermissionContext,
    agentDefinitions,
    runtimeModel,
    detail,
    signal,
  )
  const skillInfo = skillResult.skillInfo
  const skillFrontmatterTokens = skillInfo.skillFrontmatter.reduce(
    (sum, skill) => sum + skill.tokens,
    0,
  )
  const isAutoCompact = isAutoCompactEnabled()
  let skipReservedBuffer = false
  if (feature('REACTIVE_COMPACT')) {
    if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_raccoon', false)) {
      skipReservedBuffer = true
    }
  }
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isContextCollapseEnabled } =
      require('../services/contextCollapse/index.js') as typeof import('../services/contextCollapse/index.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (isContextCollapseEnabled()) {
      skipReservedBuffer = true
    }
  }

  const usageMessages = originalMessages ?? messages
  const extractedApiUsage = getCurrentUsage(usageMessages)
  const apiUsage =
    extractedApiUsage &&
    extractedApiUsage.input_tokens +
      extractedApiUsage.cache_creation_input_tokens +
      extractedApiUsage.cache_read_input_tokens >
      0
      ? extractedApiUsage
      : null

  return buildContextUsageData({
    model: runtimeModel,
    contextWindow,
    autocompactSource,
    terminalWidth,
    isAutoCompact,
    systemPromptTokens,
    claudeMdTokens,
    builtInToolTokens,
    mcpToolTokens,
    deferredToolTokens,
    deferredBuiltinTokens,
    agentTokens,
    slashCommandTokens,
    skillFrontmatterTokens,
    memoryFileDetails,
    mcpToolDetails,
    deferredBuiltinDetails,
    systemToolDetails,
    systemPromptSections,
    agentDetails,
    commandInfo,
    skillInfo,
    messageBreakdown,
    apiUsage,
    estimatedTokensAfterLastApiUsage: estimateTokensAfterLastApiUsage(
      usageMessages,
    ),
    skipReservedBuffer,
    autoCompactThreshold: isAutoCompact
      ? getEffectiveContextWindowSize(runtimeModel) - AUTOCOMPACT_BUFFER_TOKENS
      : undefined,
  })
}
