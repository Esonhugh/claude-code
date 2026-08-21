import { feature } from 'bun:bundle'
import { isReplBridgeActive } from '../../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import type { Tool } from '../../Tool.js'
import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'

// Dead code elimination: Brief tool name only needed when KAIROS or KAIROS_BRIEF is on
/* eslint-disable @typescript-eslint/no-require-imports */
const BRIEF_TOOL_NAME: string | null =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (
        require('../BriefTool/prompt.js') as typeof import('../BriefTool/prompt.js')
      ).BRIEF_TOOL_NAME
    : null
const SEND_USER_FILE_TOOL_NAME: string | null = feature('KAIROS')
  ? (
      require('../SendUserFileTool/prompt.js') as typeof import('../SendUserFileTool/prompt.js')
    ).SEND_USER_FILE_TOOL_NAME
  : null

/* eslint-enable @typescript-eslint/no-require-imports */

export { TOOL_SEARCH_TOOL_NAME } from './constants.js'

import { TOOL_SEARCH_TOOL_NAME } from './constants.js'
import { isAnt } from 'src/utils/userType.js'


const PROMPT_HEAD = `Fetches full schema definitions for deferred tools so they can be called.

`

// Matches isDeferredToolsDeltaEnabled in toolSearch.ts (not imported —
// toolSearch.ts imports from this file). When enabled: tools announced
// via system-reminder attachments. When disabled: prepended
// <available-deferred-tools> block (pre-gate behavior).
function getToolLocationHint(): string {
  const deltaEnabled =
    isAnt() ||
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_glacier_2xr', false)
  return deltaEnabled
    ? 'Deferred tools appear by name in <system-reminder> messages.'
    : 'Deferred tools appear by name in <available-deferred-tools> messages.'
}

const PROMPT_TAIL = ` Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked. This tool takes a query, matches it against the deferred tool list, and returns the matched tools' complete JSONSchema definitions inside a <functions> block. Once a tool's schema appears in that result, it is callable exactly like any tool defined at the top of the prompt.

Result format: each matched tool appears as one <function>{"description": "...", "name": "...", "parameters": {...}}</function> line inside the <functions> block — the same encoding as the tool list at the top of this prompt.

Query forms:
- "select:Read,Edit,Grep" — fetch these exact tools by name
- "notebook jupyter" — keyword search, up to max_results best matches
- "+slack send" — require "slack" in the name, rank by remaining terms`

/**
 * Check if a tool should be deferred (requires ToolSearch to load).
 * A tool is deferred if:
 * - It's an MCP tool (always deferred - workflow-specific)
 * - It has shouldDefer: true
 *
 * A tool is NEVER deferred if it has alwaysLoad: true (MCP tools set this via
 * _meta['anthropic/alwaysLoad']). This check runs first, before any other rule.
 */
export function isDeferredTool(tool: Tool): boolean {
  // Explicit opt-out via _meta['anthropic/alwaysLoad'] — tool appears in the
  // initial prompt with full schema. Checked first so MCP tools can opt out.
  if (tool.alwaysLoad === true) return false

  // MCP tools are always deferred (workflow-specific)
  if (tool.isMcp === true) return true

  // Never defer ToolSearch itself — the model needs it to load everything else
  if (tool.name === TOOL_SEARCH_TOOL_NAME) return false

  // Fork-first experiment: Agent must be available turn 1, not behind ToolSearch.
  // Lazy require: static import of forkSubagent → coordinatorMode creates a cycle
  // through constants/tools.ts at module init.
  if (feature('FORK_SUBAGENT') && tool.name === AGENT_TOOL_NAME) {
    type ForkMod = typeof import('../AgentTool/forkSubagent.js')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('../AgentTool/forkSubagent.js') as ForkMod
    if (m.isForkSubagentEnabled()) return false
  }

  // Brief is the primary communication channel whenever the tool is present.
  // Its prompt contains the text-visibility contract, which the model must
  // see without a ToolSearch round-trip. No runtime gate needed here: this
  // tool's isEnabled() IS isBriefEnabled(), so being asked about its deferral
  // status implies the gate already passed.
  if (
    (feature('KAIROS') || feature('KAIROS_BRIEF')) &&
    BRIEF_TOOL_NAME &&
    tool.name === BRIEF_TOOL_NAME
  ) {
    return false
  }

  // SendUserFile is a file-delivery communication channel (sibling of Brief).
  // Must be immediately available without a ToolSearch round-trip.
  if (
    feature('KAIROS') &&
    SEND_USER_FILE_TOOL_NAME &&
    tool.name === SEND_USER_FILE_TOOL_NAME &&
    isReplBridgeActive()
  ) {
    return false
  }

  return tool.shouldDefer === true
}

/**
 * Format one deferred-tool line for the <available-deferred-tools> user
 * message. Search hints (tool.searchHint) are not rendered — the
 * hints A/B (exp_xenhnnmn0smrx4, stopped Mar 21) showed no benefit.
 */
export function formatDeferredToolLine(tool: Tool): string {
  return tool.name
}

const MIN_TOOLS_PER_NAMESPACE_SUMMARY = 4
const MCP_TOOL_PREFIX = 'mcp__'

function getMcpNamespace(toolName: string): string | null {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return null

  const serverEnd = toolName.indexOf('__', MCP_TOOL_PREFIX.length)
  if (serverEnd === -1 || serverEnd + 2 === toolName.length) return null

  // Codex Apps exposes many connectors through one MCP server and encodes the
  // connector as an extra namespace segment. Keep those capability domains
  // separate instead of collapsing every installed app into codex_apps__*.
  if (toolName.slice(MCP_TOOL_PREFIX.length, serverEnd) === 'codex_apps') {
    const connectorEnd = toolName.indexOf('__', serverEnd + 2)
    if (connectorEnd !== -1 && connectorEnd + 2 !== toolName.length) {
      return toolName.slice(0, connectorEnd + 2)
    }
  }

  return toolName.slice(0, serverEnd + 2)
}

/**
 * Format deferred tools for model-facing availability messages. Large MCP
 * namespaces are summarized because ToolSearch discovers the exact tool by
 * capability; small namespaces stay explicit so uncommon tools remain easy
 * to spot without a search round trip.
 */
export function formatDeferredToolLines(tools: Tool[]): string[] {
  const lines: string[] = []
  const mcpNamespaces = new Map<string, Tool[]>()

  for (const tool of tools) {
    const namespace = getMcpNamespace(tool.name)
    if (namespace === null) {
      lines.push(formatDeferredToolLine(tool))
      continue
    }

    const namespaceTools = mcpNamespaces.get(namespace) ?? []
    namespaceTools.push(tool)
    mcpNamespaces.set(namespace, namespaceTools)
  }

  for (const [namespace, namespaceTools] of mcpNamespaces) {
    if (namespaceTools.length >= MIN_TOOLS_PER_NAMESPACE_SUMMARY) {
      lines.push(
        `${namespace}* (${namespaceTools.length} tools; use ToolSearch by capability)`,
      )
    } else {
      lines.push(...namespaceTools.map(formatDeferredToolLine))
    }
  }

  return lines.sort()
}

export function getPrompt(): string {
  return PROMPT_HEAD + getToolLocationHint() + PROMPT_TAIL
}
