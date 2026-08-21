import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { getSubscriptionType } from '../../utils/auth.js'
import { hasEmbeddedSearchTools } from '../../utils/embeddedTools.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import { isTeammate } from '../../utils/teammate.js'
import { isInProcessTeammate } from '../../utils/teammateContext.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { GLOB_TOOL_NAME } from '../GlobTool/prompt.js'
import { SEND_MESSAGE_TOOL_NAME } from '../SendMessageTool/constants.js'
import { AGENT_TOOL_NAME } from './constants.js'
import { isForkSubagentEnabled } from './forkSubagent.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import { isAnt } from 'src/utils/userType.js'


function getToolsDescription(agent: AgentDefinition): string {
  const { tools, disallowedTools } = agent
  const hasAllowlist = tools && tools.length > 0
  const hasDenylist = disallowedTools && disallowedTools.length > 0

  if (hasAllowlist && hasDenylist) {
    // Both defined: filter allowlist by denylist to match runtime behavior
    const denySet = new Set(disallowedTools)
    const effectiveTools = tools.filter(t => !denySet.has(t))
    if (effectiveTools.length === 0) {
      return 'None'
    }
    return effectiveTools.join(', ')
  } else if (hasAllowlist) {
    // Allowlist only: show the specific tools available
    return tools.join(', ')
  } else if (hasDenylist) {
    // Denylist only: show "All tools except X, Y, Z"
    return `All tools except ${disallowedTools.join(', ')}`
  }
  // No restrictions
  return 'All tools'
}

/**
 * Format one agent line for the agent_listing_delta attachment message:
 * `- type: whenToUse (Tools: ...)`.
 */
export function formatAgentLine(agent: AgentDefinition): string {
  const toolsDescription = getToolsDescription(agent)
  return `- ${agent.agentType}: ${agent.whenToUse} (Tools: ${toolsDescription})`
}

/**
 * Whether the agent list should be injected as an attachment message instead
 * of embedded in the tool description. When true, getPrompt() returns a static
 * description and attachments.ts emits an agent_listing_delta attachment.
 *
 * The dynamic agent list was ~10.2% of fleet cache_creation tokens: MCP async
 * connect, /reload-plugins, or permission-mode changes mutate the list →
 * description changes → full tool-schema cache bust.
 *
 * Override with CLAUDE_CODE_AGENT_LIST_IN_MESSAGES=true/false for testing.
 */
export function shouldInjectAgentListInMessages(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES)) return true
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES))
    return false
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_agent_list_attach', true)
}

export async function getPrompt(
  agentDefinitions: AgentDefinition[],
  isCoordinator?: boolean,
  allowedAgentTypes?: string[],
): Promise<string> {
  // Filter agents by allowed types when Agent(x,y) restricts which agents can be spawned
  const effectiveAgents = allowedAgentTypes
    ? agentDefinitions.filter(a => allowedAgentTypes.includes(a.agentType))
    : agentDefinitions

  // Fork subagent feature: when enabled, insert the "When to fork" section
  // (fork semantics, directive-style prompts) and swap in fork-aware examples.
  const forkEnabled = isForkSubagentEnabled()

  const whenToForkSection = forkEnabled
    ? `

## When to fork

Fork yourself (omit \`subagent_type\`) when the intermediate tool output isn't worth keeping in your context. The criterion is qualitative \u2014 "will I need this output again" \u2014 not task size.
- **Research**: fork open-ended questions. If research can be broken into independent questions, launch parallel forks in one message. A fork beats a fresh subagent for this \u2014 it inherits context and shares your cache.
- **Implementation**: prefer to fork implementation work that requires more than a couple of edits. Do research before jumping to implementation.

Forks are cheap because they share your prompt cache. Don't set \`model\` on a fork \u2014 a different model can't reuse the parent's cache. Pass a short \`name\` (one or two words, lowercase) so the user can see the fork in the teams panel and steer it mid-run.

**Don't peek.** The tool result includes an \`output_file\` path — do not Read or tail it unless the user explicitly asks for a progress check. You get a completion notification; trust it. Reading the transcript mid-flight pulls the fork's tool noise into your context, which defeats the point of forking.

**Don't race.** After launching, you know nothing about what the fork found. Never fabricate or predict fork results in any format — not as prose, summary, or structured output. The notification arrives as a user-role message in a later turn; it is never something you write yourself. If the user asks a follow-up before the notification lands, tell them the fork is still running — give status, not a guess.

**Writing a fork prompt.** Since the fork inherits your context, the prompt is a *directive* — what to do, not what the situation is. Be specific about scope: what's in, what's out, what another agent is handling. Don't re-explain background.
`
    : ''

  const writingThePromptSection = `

## Agent briefing

${
    forkEnabled
      ? 'A fresh agent with `subagent_type` starts with no conversation context. '
      : 'Each agent starts fresh. '
  }Give the goal, relevant findings or exclusions, exact scope, whether to research or edit, and what you expect it to return. Include known paths or commands. For implementation, request the specific change instead of "based on your findings, fix it."
`

  // When the gate is on, the agent list lives in an agent_listing_delta
  // attachment (see attachments.ts) instead of inline here. This keeps the
  // tool description static across MCP/plugin/permission changes so the
  // tools-block prompt cache doesn't bust every time an agent loads.
  const listViaAttachment = shouldInjectAgentListInMessages()

  const agentListSection = listViaAttachment
    ? `Available agent types are listed in <system-reminder> messages in the conversation.`
    : `Available agent types and the tools they have access to:
${effectiveAgents.map(agent => formatAgentLine(agent)).join('\n')}`

  // Shared core prompt used by both coordinator and non-coordinator modes
  const shared = `Launch a new agent to handle complex, multi-step tasks autonomously.

The ${AGENT_TOOL_NAME} tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

${agentListSection}

${
  forkEnabled
    ? `When using the ${AGENT_TOOL_NAME} tool, specify a subagent_type to use a specialized agent, or omit it to fork yourself — a fork inherits your full conversation context.`
    : `When using the ${AGENT_TOOL_NAME} tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.`
}`

  // Coordinator mode gets the slim prompt -- the coordinator system prompt
  // already covers usage notes, examples, and when-not-to-use guidance.
  if (isCoordinator) {
    return shared
  }

  // Ant-native builds alias find/grep to embedded bfs/ugrep and remove the
  // dedicated Glob/Grep tools, so point at find via Bash instead.
  const embedded = hasEmbeddedSearchTools()
  const fileSearchHint = embedded
    ? '`find` via the Bash tool'
    : `the ${GLOB_TOOL_NAME} tool`
  // The "class Foo" example is about content search. Non-embedded stays Glob
  // (original intent: find-the-file-containing). Embedded gets grep because
  // find -name doesn't look at file contents.
  const contentSearchHint = embedded
    ? '`grep` via the Bash tool'
    : `the ${GLOB_TOOL_NAME} tool`
  const whenNotToUseSection = forkEnabled
    ? ''
    : `
When NOT to use the ${AGENT_TOOL_NAME} tool:
- For a known path or code limited to 2-3 files, use ${FILE_READ_TOOL_NAME}.
- For a targeted filename or symbol search, use ${fileSearchHint} or ${contentSearchHint}.
- For tasks that do not match an available agent type.
`

  // When listing via attachment, the "launch multiple agents" note is in the
  // attachment message (conditioned on subscription there). When inline, keep
  // the existing per-call getSubscriptionType() check.
  const concurrencyNote =
    !listViaAttachment && getSubscriptionType() !== 'pro'
      ? `
- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses`
      : ''

  // Non-coordinator gets the full prompt with all sections
  return `${shared}
${whenNotToUseSection}

Usage notes:
- Include a 3-5 word description.${concurrencyNote}
- The result is not visible to the user; relay a concise summary.${
    // eslint-disable-next-line custom-rules/no-process-env-top-level
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS) &&
    !isInProcessTeammate() &&
    !forkEnabled
      ? `
- Use foreground when blocked on the result; use run_in_background only for independent work. Completion is announced automatically—do not poll, sleep, or check proactively.`
      : ''
  }
- Resume an existing agent with ${SEND_MESSAGE_TOOL_NAME} using its ID or name as \`to\`; it retains context. ${forkEnabled ? 'A fresh Agent call with subagent_type has no context.' : 'A fresh Agent call has no context.'}
- Generally trust agent output.
- Honor agent descriptions that call for proactive use.
- If the user asks to run agents in parallel, send a single message with multiple ${AGENT_TOOL_NAME} tool calls.
- \`isolation: "worktree"\` gives the agent its own git worktree (auto-cleaned if unchanged).${
    isAnt()
      ? `\n- You can set \`isolation: "remote"\` to run the agent in a remote CCR environment. This is always a background task; you'll be notified when it completes. Use for long-running tasks that need a fresh sandbox.`
      : ''
  }${
    isInProcessTeammate()
      ? `
- The run_in_background, name, team_name, and mode parameters are not available in this context. Only synchronous subagents are supported.`
      : isTeammate()
        ? `
- The name, team_name, and mode parameters are not available in this context — teammates cannot spawn other teammates. Omit them to spawn a subagent.`
        : ''
  }${whenToForkSection}${writingThePromptSection}`
}
