import type { BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { randomUUID } from 'crypto'
import { getIsNonInteractiveSession, getSessionId } from '../../bootstrap/state.js'
import type { ToolPermissionContext } from '../../Tool.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import { getDenyRuleForAgent } from '../../utils/permissions/permissions.js'
import { normalizeAgentType } from './agentTypeResolver.js'
import { AGENT_TOOL_NAME } from './constants.js'
import {
  FORK_BOILERPLATE_TAG,
} from '../../constants/xml.js'
import { isCoordinatorMode } from '../../coordinator/coordinatorMode.js'
import type {
  AssistantMessage,
  Message as MessageType,
} from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { createUserMessage } from '../../utils/messages.js'
import type { BuiltInAgentDefinition } from './loadAgentsDir.js'
import { buildChildMessage } from '../../utils/forkBoilerplate.js'
export { buildChildMessage } from '../../utils/forkBoilerplate.js'

// Remember an enabled mode for the active session so schema/prompt defaults do
// not change after interactive startup. Explicit opt-out and coordinator mode
// always win; a new conversation gets a fresh decision.
let enabledSessionId: string | undefined
let enabledSource: 'env' | 'default' | undefined

export function isForkSubagentEnabled(): boolean {
  const sessionId = getSessionId()
  if (sessionId !== enabledSessionId) {
    enabledSessionId = sessionId
    enabledSource = undefined
  }
  if (!canUseScriptFork()) return false
  if (enabledSource === undefined) {
    enabledSource = isEnvTruthy(process.env.CLAUDE_CODE_FORK_SUBAGENT)
      ? 'env'
      : getIsNonInteractiveSession()
        ? undefined
        : 'default'
    if (enabledSource !== undefined) {
      logForDebugging(`[ForkMode] enabled source=${enabledSource} sessionId=${sessionId}`)
    }
  }
  return enabledSource !== undefined
}

function canUseScriptFork(): boolean {
  return !isCoordinatorMode() && !isEnvDefinedFalsy(process.env.CLAUDE_CODE_FORK_SUBAGENT)
}

export function getForkAgentAvailability({ activeAgents, allowedAgentTypes, permissionContext, innerCall }: {
  activeAgents: readonly import('./loadAgentsDir.js').AgentDefinition[]
  allowedAgentTypes?: string[]
  permissionContext: ToolPermissionContext
  innerCall?: boolean
}) {
  if (!(isForkSubagentEnabled() || innerCall === true && canUseScriptFork()) ||
      activeAgents.some(agent => normalizeAgentType(agent.agentType) === FORK_SUBAGENT_TYPE) ||
      !(allowedAgentTypes?.includes(FORK_SUBAGENT_TYPE) ?? true)) {
    return { available: false, denyRule: null }
  }
  const denyRule = getDenyRuleForAgent(permissionContext, AGENT_TOOL_NAME, FORK_SUBAGENT_TYPE)
  return { available: denyRule === null, denyRule }
}

/** Synthetic agent type name used for analytics when the fork path fires. */
export const FORK_SUBAGENT_TYPE = 'fork'

/**
 * Synthetic agent definition for the fork path.
 *
 * Not registered in builtInAgents — selected explicitly via `subagent_type:
 * "fork"` when available. `tools: ['*']` with `useExactTools` means the fork
 * child inherits the parent's tool definitions. Main-thread-only calls still
 * enforce their own validation.
 * `permissionMode: 'bubble'` surfaces permission prompts to the
 * parent terminal. `model: 'inherit'` keeps the parent's model for context
 * length parity.
 *
 * The getSystemPrompt here is unused: the fork path passes
 * `override.systemPrompt` with the parent's already-rendered system prompt
 * bytes, threaded via `toolUseContext.renderedSystemPrompt`. Reconstructing
 * by re-calling getSystemPrompt() can diverge (GrowthBook cold→warm) and
 * bust the prompt cache; threading the rendered bytes is byte-exact.
 */
export const FORK_AGENT = {
  agentType: FORK_SUBAGENT_TYPE,
  whenToUse:
    'Fork — inherits full conversation context. Selected explicitly via subagent_type: "fork" when the fork gate is on; never the default.',
  tools: ['*'],
  maxTurns: 200,
  model: 'inherit',
  permissionMode: 'bubble',
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () => '',
} satisfies BuiltInAgentDefinition

/**
 * Guard against recursive forking. Fork children keep the Agent tool in their
 * tool pool for cache-identical tool definitions, so we reject fork attempts
 * at call time by detecting the fork boilerplate tag in conversation history.
 */
export function isInForkChild(messages: MessageType[]): boolean {
  return messages.some(m => {
    if (m.type !== 'user') return false
    const content = m.message.content
    if (!Array.isArray(content)) return false
    return content.some(
      block =>
        block.type === 'text' &&
        // @ts-ignore - recovered code
        block.text.includes(`<${FORK_BOILERPLATE_TAG}>`),
    )
  })
}

/** Placeholder text used for all tool_result blocks in the fork prefix.
 * Must be identical across all fork children for prompt cache sharing. */
const FORK_PLACEHOLDER_RESULT = 'Fork started — processing in background'

/**
 * Build the forked conversation messages for the child agent.
 *
 * For prompt cache sharing, all fork children must produce byte-identical
 * API request prefixes. This function:
 * 1. Keeps the full parent assistant message (all tool_use blocks, thinking, text)
 * 2. Builds a single user message with tool_results for every tool_use block
 *    using an identical placeholder, then appends a per-child directive text block
 *
 * Result: [...history, assistant(all_tool_uses), user(placeholder_results..., directive)]
 * Only the final text block differs per child, maximizing cache hits.
 */
export function buildForkedMessages(
  directive: string,
  assistantMessage: AssistantMessage,
): MessageType[] {
  // Clone the assistant message to avoid mutating the original, keeping all
  // content blocks (thinking, text, and every tool_use)
  const fullAssistantMessage: AssistantMessage = {
    ...assistantMessage,
    uuid: randomUUID(),
    message: {
      ...assistantMessage.message,
      content: [...assistantMessage.message.content],
    },
  }

  // Collect all tool_use blocks from the assistant message
  const toolUseBlocks = assistantMessage.message.content.filter(
    // @ts-ignore - recovered code
    (block): block is BetaToolUseBlock => block.type === 'tool_use',
  )

  if (toolUseBlocks.length === 0) {
    logForDebugging(
      `No tool_use blocks found in assistant message for fork directive: ${directive.slice(0, 50)}...`,
      { level: 'error' },
    )
    return [
      createUserMessage({
        content: [
          { type: 'text' as const, text: buildChildMessage(directive) },
        ],
      }),
    ]
  }

  // Build tool_result blocks for every tool_use, all with identical placeholder text
  const toolResultBlocks = toolUseBlocks.map(block => ({
    type: 'tool_result' as const,
    tool_use_id: block.id,
    content: [
      {
        type: 'text' as const,
        text: FORK_PLACEHOLDER_RESULT,
      },
    ],
  }))

  // Build a single user message: all placeholder tool_results + the per-child directive
  // TODO(smoosh): this text sibling creates a [tool_result, text] pattern on the wire
  // (renders as </function_results>\n\nHuman:<text>). One-off per-child construction,
  // not a repeated teacher, so low-priority. If we ever care, use smooshIntoToolResult
  // from src/utils/messages.ts to fold the directive into the last tool_result.content.
  const toolResultMessage = createUserMessage({
    content: [
      // @ts-ignore - recovered code
      ...toolResultBlocks,
      {
        // @ts-ignore - recovered code
        type: 'text' as const,
        text: buildChildMessage(directive),
      },
    ],
  })

  return [fullAssistantMessage, toolResultMessage]
}

/**
 * Notice injected into fork children running in an isolated worktree.
 * Tells the child to translate paths from the inherited context, re-read
 * potentially stale files, and that its changes are isolated.
 */
export function buildWorktreeNotice(
  parentCwd: string,
  worktreeCwd: string,
): string {
  return `You've inherited the conversation context above from a parent agent working in ${parentCwd}. You are operating in an isolated git worktree at ${worktreeCwd} — same repository, same relative file structure, separate working copy. Paths in the inherited context refer to the parent's working directory; translate them to your worktree root. Re-read files before editing if the parent may have modified them since they appear in the context. Your changes stay in this worktree and will not affect the parent's files.`
}
