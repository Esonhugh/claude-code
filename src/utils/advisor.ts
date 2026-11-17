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

/** Whether requests may carry the advisor at all (provider, env, refusals). */
export function isAdvisorToolAllowed(): boolean {
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL) ||
    isAdvisorRefusedHere()
  ) {
    return false
  }
  return (
    getAPIProvider() === 'firstParty' &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)
  )
}

/**
 * Official `Lx()` also reads the `tengu_sage_compass2` flag. This build keeps
 * the advisor on locally whatever GrowthBook serves; only
 * CLAUDE_CODE_DISABLE_ADVISOR_TOOL (or a refusal) turns it off.
 */
export function isAdvisorEnabled(): boolean {
  return isAdvisorToolAllowed()
}

export function isAdvisorRankCheckBypassed(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL)
}

// @[MODEL LAUNCH]: Add the new model's advisor rank (official model catalog
// `advisor_rank`). Models without a rank cannot use or be the advisor.
const ADVISOR_RANKS: ReadonlyArray<readonly [string, number]> = (
  [
    ['haiku-4-5', 1],
    ['sonnet-4-6', 2],
    ['opus-4-6', 3],
    ['haiku-5-5', 4],
    ['sonnet-5', 4],
    ['opus-4-7', 5],
    ['opus-4-8', 5],
    ['sonnet-5-5', 6],
    ['opus-5', 7],
    ['opus-5-5', 7],
    ['fable-5', 8],
    ['mythos-5', 8],
    ['fable-5-1', 9],
    ['mythos-5-1', 9],
    ['fable-5-2', 10],
    ['mythos-5-2', 10],
  ] as const
).slice().sort((a, b) => b[0].length - a[0].length)

const MIN_ADVISOR_RANK = 2

export const ADVISOR_MODEL_ALIASES = ['fable', 'opus', 'sonnet'] as const

/** Full model id an advisor name (alias or id) resolves to. */
export function resolveAdvisorModelId(model: string): string {
  return normalizeModelStringForAPI(parseUserSpecifiedModel(model))
}

// After a rank key the id may only end, open a `[1m]` style suffix, or carry
// an 8-digit snapshot date. `claude-opus-5-1` is not `opus-5`: an unknown
// minor version has no rank.
const RANK_KEY_TAIL = /^(?:$|\[|-\d{8}(?:$|\[))/

function findRankEntry(model: string): readonly [string, number] | undefined {
  const id = resolveAdvisorModelId(model).toLowerCase()
  for (const entry of ADVISOR_RANKS) {
    const key = entry[0]
    for (let at = id.indexOf(key); at !== -1; at = id.indexOf(key, at + 1)) {
      const before = id[at - 1]
      if (before !== undefined && /[a-z0-9]/.test(before)) continue
      if (RANK_KEY_TAIL.test(id.slice(at + key.length))) return entry
    }
  }
  return undefined
}

export function getAdvisorRank(model: string): number | undefined {
  return findRankEntry(model)?.[1]
}

/** The model catalog key (`opus-5`, `fable-5-1`, ...) the model resolves to. */
export function getAdvisorRankKey(model: string): string | undefined {
  return findRankEntry(model)?.[0]
}

/** Whether the main loop model can call the advisor. */
export function modelSupportsAdvisor(model: string): boolean {
  return isAdvisorRankCheckBypassed() || getAdvisorRank(model) !== undefined
}

function canModelAdvise(model: string): boolean {
  if (isAdvisorRankCheckBypassed()) return true
  const rank = getAdvisorRank(model)
  return rank !== undefined && rank >= MIN_ADVISOR_RANK
}

/** Whether the model can serve as the advisor (availableModels and rank). */
export function isValidAdvisorModel(model: string): boolean {
  return isModelAllowed(model) && canModelAdvise(model)
}

function compareAdvisorRanks(mainModel: string, advisor: string): boolean {
  const mainRank = getAdvisorRank(mainModel)
  const advisorRank = getAdvisorRank(advisor)
  if (mainRank === undefined || advisorRank === undefined) return true
  return mainRank <= advisorRank
}

/** The advisor must be at least as capable as the model it advises. */
export function isAdvisorPairingAllowed(
  mainModel: string,
  advisor: string,
): boolean {
  return isAdvisorRankCheckBypassed() || compareAdvisorRanks(mainModel, advisor)
}

/**
 * Official `XBn`: the rank comparison alone, without the experimental env
 * short-circuit. A model without a rank still passes.
 */
export function isAdvisorPairingAllowedByRank(
  mainModel: string,
  advisor: string,
): boolean {
  return compareAdvisorRanks(mainModel, advisor)
}

/**
 * Official `xXi`, for the standby entry: both models must have a rank and
 * the advisor's must be at least the main model's.
 */
export function isAdvisorPairingAllowedStrict(
  mainModel: string,
  advisor: string,
): boolean {
  const mainRank = getAdvisorRank(mainModel)
  const advisorRank = getAdvisorRank(advisor)
  return (
    mainRank !== undefined && advisorRank !== undefined && mainRank <= advisorRank
  )
}

export function isSameAdvisorModel(a: string, b: string): boolean {
  return resolveAdvisorModelId(a) === resolveAdvisorModelId(b)
}

export function formatAdvisorModelName(model: string): string {
  return capitalize(renderDefaultModelSetting(model))
}

/** Aliases the picker and error messages offer. */
export function getAdvisorAliasOptions(): string[] {
  return ADVISOR_MODEL_ALIASES.filter(alias =>
    isValidAdvisorModel(resolveAdvisorModelId(alias)),
  )
}

let warnedUnrankedBase = false

/** The advisor a request for `mainModel` should carry, if any. */
export function resolveAdvisorModel(
  setting: string | undefined,
  mainModel: string,
): string | undefined {
  if (!isAdvisorEnabled() || !setting) return undefined
  const advisor = resolveAdvisorModelId(setting)
  if (!modelSupportsAdvisor(mainModel)) {
    logForDebugging(
      `[AdvisorTool] Skipping advisor - base model ${mainModel} does not support advisor`,
    )
    if (!warnedUnrankedBase) {
      warnedUnrankedBase = true
      // eslint-disable-next-line no-console
      console.warn(
        `Warning: Advisor disabled — base model '${mainModel}' has no advisor rank in the model catalog. Switch to a public model alias (opus, sonnet, fable) or set CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL=1.`,
      )
    }
    return undefined
  }
  if (!isValidAdvisorModel(advisor)) {
    logForDebugging(
      `[AdvisorTool] Skipping advisor - ${advisor} is not a valid advisor model`,
    )
    return undefined
  }
  if (!isAdvisorPairingAllowed(mainModel, advisor)) {
    logForDebugging(
      `[AdvisorTool] Skipping advisor - ${advisor} cannot advise ${mainModel} (advisor must be at least as capable as the base model)`,
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

export const ADVISOR_TOOL_INSTRUCTIONS = `# Advisor Tool

You have access to an \`advisor\` tool backed by a stronger reviewer model. It takes NO parameters -- when you call advisor(), your entire conversation history is automatically forwarded. They see the task, every tool call you've made, every result you've seen.

Call advisor BEFORE substantive work -- before writing, before committing to an interpretation, before building on an assumption. If the task requires orientation first (finding files, fetching a source, seeing what's there), do that, then call advisor. Orientation is not substantive work. Writing, editing, and declaring an answer are.

Also call advisor:
- When you believe the task is complete. BEFORE this call, make your deliverable durable: write the file, save the result, commit the change. The advisor call takes time; if the session ends during it, a durable result persists and an unwritten one doesn't.
- When stuck -- errors recurring, approach not converging, results that don't fit.
- When considering a change of approach.

On tasks longer than a few steps, call advisor at least once before committing to an approach and once before declaring done. On short reactive tasks where the next action is dictated by tool output you just read, you don't need to keep calling -- the advisor adds most of its value on the first call, before the approach crystallizes.

Give the advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim (the file says X, the paper states Y), adapt. A passing self-test is not evidence the advice is wrong -- it's evidence your test doesn't check what the advice is checking.

If you've already retrieved data pointing one way and the advisor points another: don't silently switch. Surface the conflict in one more advisor call -- "I found X, you suggest Y, which constraint breaks the tie?" The advisor saw your evidence but may have underweighted it; a reconcile call is cheaper than committing to the wrong branch.`

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
