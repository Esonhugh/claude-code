import type { PermissionResult } from '../../types/permissions.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { getEmptyToolPermissionContext, toolMatchesName } from '../../Tool.js'
import { permissionRuleValueFromString } from '../../utils/permissions/permissionRuleParser.js'
import { bashToolCheckPermission } from '../BashTool/bashPermissions.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'
import { TOOL_SEARCH_TOOL_NAME } from '../ToolSearchTool/constants.js'

// Official 2.1.303's per-spawn tool policy for workflow script agents: `disallowedTools`
// narrows the subagent's tool pool and `bashCommandClamp` keeps only the Bash commands
// that match its Bash(<rule>) entries (and withholds MCP tools and ToolSearch).
export type WorkflowAgentToolPolicy = {
  disallowedTools?: string[]
  bashCommandClamp?: string[]
}

export const WORKFLOW_BASH_CLAMP_NO_BASH_MESSAGE =
  `agent() opts.bashCommandClamp can bind nothing: the spawned agent's resolved tool pool has no ${BASH_TOOL_NAME} (removed by this spawn's disallowedTools, the agent definition's denies, or absent from the session pool). A clamp on a Bash-less agent means the commands it was meant to keep are unavailable — refusing the spawn rather than running a blind agent. Drop the clamp or the Bash deny.`

function describeMalformedList(value: unknown): string {
  return Array.isArray(value)
    ? 'an array with non-string, empty, or whitespace-padded entries'
    : typeof value
}

function isTrimmedStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(entry => typeof entry === 'string' && entry !== '' && entry === entry.trim())
  )
}

function uniqueSorted(entries: string[]): string[] | undefined {
  const unique = [...new Set(entries)].sort()
  return unique.length === 0 ? undefined : unique
}

export function normalizeWorkflowDisallowedTools(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!isTrimmedStringList(value)) {
    throw new Error(
      `agent() opts.disallowedTools must be an array of non-empty tool-name strings (e.g. ['Write']); got ${describeMalformedList(value)}. Refusing the spawn rather than running it un-narrowed.`,
    )
  }
  return uniqueSorted(value)
}

export function normalizeWorkflowBashCommandClamp(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!isTrimmedStringList(value)) {
    throw new Error(
      `agent() opts.bashCommandClamp must be an array of non-empty strings; got ${describeMalformedList(value)}. Refusing the spawn rather than running it un-clamped.`,
    )
  }
  const entries = uniqueSorted(value)
  for (const entry of entries ?? []) {
    const { toolName, ruleContent } = permissionRuleValueFromString(entry)
    const problem =
      toolName !== BASH_TOOL_NAME
        ? ` names '${toolName}' instead of ${BASH_TOOL_NAME}`
        : ruleContent === undefined || ruleContent === ''
          ? ' has no rule content'
          : ruleContent !== ruleContent.trim()
            ? ' has whitespace-padded rule content'
            : undefined
    if (problem !== undefined) {
      throw new Error(
        `agent() opts.bashCommandClamp entry '${entry}' is not a ${BASH_TOOL_NAME}(<command rule>) rule: it${problem}. Refusing the spawn rather than running it with an inert clamp entry.`,
      )
    }
  }
  return entries
}

export function workflowPolicyDeniesTool(policy: WorkflowAgentToolPolicy, toolName: string): boolean {
  return (
    policy.disallowedTools?.some(spec => permissionRuleValueFromString(spec).toolName === toolName) ??
    false
  )
}

// The deny list the Agent tool merges into the selected agent definition.
export function workflowPolicyDisallowedTools(policy: WorkflowAgentToolPolicy): string[] {
  return [
    ...(policy.disallowedTools ?? []),
    ...(policy.bashCommandClamp?.length ? ['mcp__*', TOOL_SEARCH_TOOL_NAME] : []),
  ]
}

// Bash commands outside the clamp are denied before the session's own permission check runs.
export function clampWorkflowBashTool(tool: Tool, bashCommandClamp: string[]): Tool {
  const clampContext = {
    ...getEmptyToolPermissionContext(),
    alwaysAllowRules: { command: bashCommandClamp },
  }
  return {
    ...tool,
    async checkPermissions(input: unknown, context: ToolUseContext): Promise<PermissionResult> {
      const command = (input as { command?: unknown }).command
      const verdict =
        typeof command === 'string'
          ? bashToolCheckPermission({ command } as Parameters<typeof bashToolCheckPermission>[0], clampContext)
          : undefined
      if (verdict?.behavior !== 'allow') {
        return {
          behavior: 'deny',
          message: `Permission to use ${BASH_TOOL_NAME} with command ${typeof command === 'string' ? command.trim() : ''} has been denied: this workflow agent is clamped to ${bashCommandClamp.join(', ')}.`,
          decisionReason: { type: 'other', reason: 'workflow agent() bashCommandClamp' },
        }
      }
      return tool.checkPermissions(input as never, context)
    },
  } as Tool
}

export function applyWorkflowBashCommandClamp(tools: readonly Tool[], policy: WorkflowAgentToolPolicy | undefined): readonly Tool[] {
  const clamp = policy?.bashCommandClamp
  if (!clamp?.length) return tools
  return tools.map(tool => (toolMatchesName(tool, BASH_TOOL_NAME) ? clampWorkflowBashTool(tool, clamp) : tool))
}
