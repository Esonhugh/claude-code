import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { Message } from '../types/message.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import {
  normalizeModelStringForAPI,
  parseUserSpecifiedModel,
  renderDefaultModelSetting,
} from './model/model.js'
import { isModelAllowed } from './model/modelAllowlist.js'
import { getAPIProvider } from './model/providers.js'
import { getInitialSettings } from './settings/settings.js'
import { capitalize } from './stringUtils.js'

// The SDK does not yet have types for advisor blocks.
// TODO(hackyon): Migrate to the real anthropic SDK types when this feature ships publicly
export type AdvisorServerToolUseBlock = {
  type: 'server_tool_use'
  id: string
  name: 'advisor'
  input: { [key: string]: unknown }
}

export type AdvisorToolResultBlock = {
  type: 'advisor_tool_result'
  tool_use_id: string
  content:
    | {
        type: 'advisor_result'
        text: string
        stop_reason?: string
      }
    | {
        type: 'advisor_redacted_result'
        encrypted_content: string
        stop_reason?: string
      }
    | {
        type: 'advisor_tool_result_error'
        error_code: string
      }
}

export type AdvisorBlock = AdvisorServerToolUseBlock | AdvisorToolResultBlock

export function isAdvisorBlock(param: {
  type: string
  name?: string
}): param is AdvisorBlock {
  return (
    param.type === 'advisor_tool_result' ||
    (param.type === 'server_tool_use' && param.name === 'advisor')
  )
}

export const ADVISOR_ERROR_CODES = [
  'max_uses_exceeded',
  'too_many_requests',
  'overloaded',
  'prompt_too_long',
  'execution_time_exceeded',
  'unavailable',
] as const

function getAdvisorResultContent(
  block: object,
): { type: string; [key: string]: unknown } | undefined {
  if (!('content' in block)) return undefined
  const content = block.content
  if (typeof content !== 'object' || content === null || !('type' in content)) {
    return undefined
  }
  return content as { type: string; [key: string]: unknown }
}

/** Error code to show; anything outside the known list reads "unknown". */
export function getAdvisorErrorCode(block: object): string | undefined {
  const content = getAdvisorResultContent(block)
  if (content?.type !== 'advisor_tool_result_error') return undefined
  const code = content.error_code
  if (typeof code !== 'string') return 'unknown'
  return ADVISOR_ERROR_CODES.find(c => c === code) ?? 'unknown'
}

export function isAdvisorRefusal(block: object): boolean {
  const content = getAdvisorResultContent(block)
  if (
    content?.type !== 'advisor_result' &&
    content?.type !== 'advisor_redacted_result'
  ) {
    return false
  }
  return content.stop_reason === 'refusal'
}

export function getAdvisorRefusalText(block: object): string | undefined {
  if (!isAdvisorRefusal(block)) return undefined
  const content = getAdvisorResultContent(block)
  if (content?.type !== 'advisor_result') return undefined
  const text = content.text
  return typeof text === 'string' && text ? text : undefined
}
// Refusals the server scoped beyond one conversation. They last until the
// process exits.
let refusedForProcess = false
const refusedHosts = new Set<string>()

export function getAdvisorHostKey(): string {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) return 'default'
  try {
    return new URL(baseUrl).host || 'default'
  } catch {
    return 'default'
  }
}

export function recordAdvisorRefusal(scope: 'process' | 'host'): void {
  if (scope === 'process') refusedForProcess = true
  else refusedHosts.add(getAdvisorHostKey())
}

export function resetAdvisorRefusalsForTesting(): void {
  refusedForProcess = false
  refusedHosts.clear()
}

function isAdvisorRefusedHere(): boolean {
  return refusedForProcess || refusedHosts.has(getAdvisorHostKey())
}

export const ADVISOR_TOOL_NAME = 'advisor'

/**
 * The advisor is off unless CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL is
 * set: no server-side entry, no beta, no local tool, no /advisor.
 * CLAUDE_CODE_DISABLE_ADVISOR_TOOL wins over it. Official `Lx()` also reads
 * the `tengu_sage_compass2` flag; this build does not ask GrowthBook.
 */
export function isAdvisorEnabled(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL) &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL)
  )
}

/**
 * Whether requests may carry the server-side advisor (provider, env,
 * refusals). Where they may not, the local advisor answers instead: `advisor`
 * as an ordinary client-executed tool that sends its own request to the
 * advisor model (not in the official client).
 */
export function isAdvisorToolAllowed(): boolean {
  return (
    isAdvisorEnabled() &&
    !isAdvisorRefusedHere() &&
    getAPIProvider() === 'firstParty' &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)
  )
}

/** Full model id an advisor name (alias or id) resolves to. */
export function resolveAdvisorModelId(model: string): string {
  return normalizeModelStringForAPI(parseUserSpecifiedModel(model))
}

/**
 * Whether the model can serve as the advisor. Any model availableModels
 * allows can, whatever the main model: the endpoint has the last word, and
 * the local advisor answers what it refuses.
 */
export function isValidAdvisorModel(model: string): boolean {
  return isModelAllowed(model)
}

export function isSameAdvisorModel(a: string, b: string): boolean {
  return resolveAdvisorModelId(a) === resolveAdvisorModelId(b)
}

export function formatAdvisorModelName(model: string): string {
  return capitalize(renderDefaultModelSetting(model))
}

/** The model the local advisor tool asks, if the setting names a usable one. */
export function getLocalAdvisorModel(
  setting: string | undefined,
): string | undefined {
  if (!isAdvisorEnabled() || !setting) return undefined
  const advisor = resolveAdvisorModelId(setting)
  return isValidAdvisorModel(advisor) ? advisor : undefined
}

/**
 * The tools a request offers: the local advisor tool goes out only with a
 * request the local advisor answers (`localAdvisorModel` of its
 * AdvisorRequest). Returns `tools` itself when nothing is left out.
 */
export function omitLocalAdvisorTool<T extends { readonly name: string }>(
  tools: readonly T[],
  localAdvisorModel: string | undefined,
): readonly T[] {
  if (!isAdvisorEnabled() || localAdvisorModel !== undefined) return tools
  return tools.filter(tool => tool.name !== ADVISOR_TOOL_NAME)
}

/** The server-side advisor a request should carry, if any. */
export function resolveAdvisorModel(
  setting: string | undefined,
): string | undefined {
  if (!isAdvisorToolAllowed() || !setting) return undefined
  const advisor = resolveAdvisorModelId(setting)
  if (!isValidAdvisorModel(advisor)) {
    logForDebugging(
      `[AdvisorTool] Skipping advisor - ${advisor} is not a valid advisor model`,
    )
    return undefined
  }
  logForDebugging(
    `[AdvisorTool] Server-side tool enabled with ${advisor} as the advisor model`,
  )
  return advisor
}

export function getInitialAdvisorSetting(): string | undefined {
  if (!isAdvisorEnabled()) {
    return undefined
  }
  const setting = getInitialSettings().advisorModel
  return typeof setting === 'string' && setting !== '' ? setting : undefined
}

export function getAdvisorUsage(
  usage: BetaUsage,
): Array<BetaUsage & { model: string }> {
  const iterations = usage.iterations as
    | Array<{ type: string }>
    | null
    | undefined
  if (!iterations) {
    return []
  }
  return iterations.filter(
    it => it.type === 'advisor_message',
  ) as unknown as Array<BetaUsage & { model: string }>
}

export type AdvisorToolAttachment =
  | {
      type: 'advisor_tool'
      available: true
      model: string
      abbreviated?: true
      /** Sent as a tool_addition (mid-conversation tool-change beta). */
      toolChange?: 'add'
    }
  | {
      type: 'advisor_tool'
      available: false
      model?: string
      /** Sent as a tool_removal (mid-conversation tool-change beta). */
      toolChange?: 'remove'
      byBase?: true
    }

// When and how to consult the advisor (official 2.1.325 text), shared by the
// server-side instructions and the local tool's prompt.
const ADVISOR_GUIDANCE = `Call advisor BEFORE substantive work -- before writing, before committing to an interpretation, before building on an assumption. If the task requires orientation first (finding files, fetching a source, seeing what's there), do that, then call advisor. Orientation is not substantive work. Writing, editing, and declaring an answer are.

Also call advisor:
- When you believe the task is complete. BEFORE this call, make your deliverable durable: write the file, save the result, commit the change. The advisor call takes time; if the session ends during it, a durable result persists and an unwritten one doesn't.
- When stuck -- errors recurring, approach not converging, results that don't fit.
- When considering a change of approach.

On tasks longer than a few steps, call advisor at least once before committing to an approach and once before declaring done. On short reactive tasks where the next action is dictated by tool output you just read, you don't need to keep calling -- the advisor adds most of its value on the first call, before the approach crystallizes.

Give the advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim (the file says X, the paper states Y), adapt. A passing self-test is not evidence the advice is wrong -- it's evidence your test doesn't check what the advice is checking.

If you've already retrieved data pointing one way and the advisor points another: don't silently switch. Surface the conflict in one more advisor call -- "I found X, you suggest Y, which constraint breaks the tie?" The advisor saw your evidence but may have underweighted it; a reconcile call is cheaper than committing to the wrong branch.`

export const ADVISOR_TOOL_INSTRUCTIONS = `# Advisor Tool

You have access to an \`advisor\` tool backed by a stronger reviewer model. It takes NO parameters -- when you call advisor(), your entire conversation history is automatically forwarded. They see the task, every tool call you've made, every result you've seen.

${ADVISOR_GUIDANCE}`

/** Prompt of the local advisor tool: no claim about which model is stronger. */
export const LOCAL_ADVISOR_TOOL_PROMPT = `Consult the advisor: a second model the user chose to review your work. It takes NO parameters -- when you call advisor(), your conversation so far is forwarded to it: the task, every tool call you've made, every result you've seen. Its advice comes back as the tool result. Say what you want advice on in your message before the call; the advisor reads that as your question.

${ADVISOR_GUIDANCE}`

const ADVISOR_AVAILABLE_ABBREVIATED =
  'The advisor tool is available; the advisor instructions announced earlier apply.'
const ADVISOR_NO_LONGER_AVAILABLE =
  'The advisor tool is no longer available; disregard the earlier advisor instructions.'

export function getAdvisorAnnouncementText(
  attachment: AdvisorToolAttachment,
): string {
  if (!attachment.available) return ADVISOR_NO_LONGER_AVAILABLE
  return attachment.abbreviated
    ? ADVISOR_AVAILABLE_ABBREVIATED
    : ADVISOR_TOOL_INSTRUCTIONS
}

function isAdvisorToolAttachment(
  message: Message,
): message is Message & { attachment: AdvisorToolAttachment } {
  return (
    message.type === 'attachment' && message.attachment.type === 'advisor_tool'
  )
}

export function getLastAdvisorAttachment(
  messages: readonly Message[],
): AdvisorToolAttachment | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (isAdvisorToolAttachment(message)) return message.attachment
  }
  return undefined
}

/** Whether the full instructions were announced and are still in context. */
export function hasFullAdvisorAnnouncement(
  messages: readonly Message[],
): boolean {
  return messages.some(
    message =>
      isAdvisorToolAttachment(message) &&
      message.attachment.available &&
      !message.attachment.abbreviated,
  )
}

/** Official `GOr`: the latest tool change an advisor_tool attachment made. */
export function getLastAdvisorToolChange(
  messages: readonly Message[],
): 'add' | 'remove' | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (isAdvisorToolAttachment(message) && message.attachment.toolChange) {
      return message.attachment.toolChange
    }
  }
  return undefined
}
