import { APIError } from '@anthropic-ai/sdk'
import {
  ADVISOR_BETA_HEADER,
  MID_CONVERSATION_SYSTEM_BETA_HEADER,
  MID_CONVERSATION_TOOL_CHANGES_BETA_HEADER,
} from '../../constants/betas.js'

/**
 * How far an advisor refusal reaches, like official 2.1.325: the whole
 * process when the organization lacks the advisor, the current host when the
 * endpoint does not know the tool type or the beta, and otherwise only the
 * conversation that sent it.
 */
export type AdvisorRefusalScope = 'process' | 'host' | 'conversation'

export type AdvisorRefusal = {
  scope: AdvisorRefusalScope
  /** The error rejected the advisor beta header rather than the tool entry. */
  betaHeader: boolean
}

const ADVISOR_INPUT_TAG = new RegExp(
  `^${'advisor_20260301'.replace(/\d+$/, '')}\\d+$`,
)

function hasInputTag(message: string, tag: RegExp): boolean {
  return [...message.matchAll(/Input tag '([\w.-]+)'/g)].some(([, name]) =>
    tag.test(name!),
  )
}

function hasAdvisorInputTag(message: string): boolean {
  return hasInputTag(message, ADVISOR_INPUT_TAG)
}

function hasCapabilityRejection(message: string, capability: string): boolean {
  const marker = `capability_rejected: ${capability}`
  for (let at = message.indexOf(marker); at !== -1; at = message.indexOf(marker, at + 1)) {
    const next = message[at + marker.length]
    if (next === undefined || !/[A-Za-z0-9_:.-]/.test(next)) return true
  }
  return false
}

/** Official `FE`: the message rejects this beta header. */
function rejectsBetaHeader(message: string, header: string): boolean {
  return (
    (message.includes(header) && /anthropic[-_]beta/.test(message)) ||
    hasCapabilityRejection(message, `beta_header:${header}`)
  )
}

function rejectsAdvisorBeta(error: APIError): boolean {
  return error.status === 400 && rejectsBetaHeader(error.message, ADVISOR_BETA_HEADER)
}

function isAdvisorRefusalError(error: APIError): boolean {
  const message = error.message
  if (error.status === 400) {
    return (
      message.includes('the advisor tool is not available') ||
      message.includes('cannot be used as an advisor') ||
      /tools\.\d+\.model: /.test(message) ||
      hasAdvisorInputTag(message) ||
      rejectsAdvisorBeta(error)
    )
  }
  return error.status === 422 && hasAdvisorInputTag(message)
}

/**
 * Official `Xlt`: the server could not process an advisor result sent back
 * in the history, so the request is sent again without advisor blocks.
 */
export function isAdvisorResultUnprocessableError(error: unknown): boolean {
  return (
    error instanceof APIError &&
    error.status === 400 &&
    (error.message.includes('Advisor tool result content could not be processed') ||
      error.message.includes('found in advisor_tool_result blocks'))
  )
}

/**
 * Official `Qlt` and `hCn`: whether a retry without the advisor may help.
 * Unlike official, a pairing the server will not serve ("cannot be used as
 * an advisor when the request model is") is a refusal too: the local advisor
 * answers that conversation.
 */
export function classifyAdvisorRefusal(
  error: unknown,
  betas: readonly string[],
): AdvisorRefusal | undefined {
  if (!(error instanceof APIError) || !isAdvisorRefusalError(error)) {
    return undefined
  }
  const betaHeader = betas.includes(ADVISOR_BETA_HEADER) && rejectsAdvisorBeta(error)
  const scope: AdvisorRefusalScope = error.message.includes(
    'not available for this organization',
  )
    ? 'process'
    : hasAdvisorInputTag(error.message) || rejectsAdvisorBeta(error)
      ? 'host'
      : 'conversation'
  return { scope, betaHeader }
}

/**
 * A 400 or 422 that names nothing this client knows. On a request that
 * carried the advisor it may be the endpoint refusing the entry in its own
 * words; only a retry without the advisor can tell (compare
 * `getToolSearchRefusal`).
 */
export function isUnattributedRequestError(error: unknown): error is APIError {
  if (!(error instanceof APIError)) return false
  if (error.status !== 400 && error.status !== 422) return false
  const body = error.error as { error?: { type?: string } } | undefined
  if (body?.error?.type === 'billing_error') return false
  return !error.message.toLowerCase().includes('prompt is too long')
}

function getErrorCode(error: APIError): unknown {
  const body = error.error as
    | { error?: { details?: { error_code?: unknown } } }
    | undefined
  return body?.error?.details?.error_code
}

const TOOL_CHANGES_UNSUPPORTED_CODE = 'mid_conversation_tool_changes_not_supported'
const SYSTEM_TURN_UNSUPPORTED_CODE = 'mid_conversation_system_not_supported'

/** Official `rTo`: a cache_control shape error, not a tool-change one. */
function isCacheControlShapeError(message: string): boolean {
  if (!message.includes('cache_control')) return false
  if (/system messages?\b|role .{0,2}system/i.test(message)) return false
  if (message.includes('empty text block')) return false
  if (/\bsystem\.\d+\./.test(message) || message.includes('tool_result')) return false
  if (/\bttl\b/i.test(message)) return false
  const lower = message.toLowerCase()
  return [
    'not permitted',
    'cannot be set',
    'unknown name',
    'unknown field',
    'unrecognized',
    'additional propert',
  ].some(text => lower.includes(text))
}

export type ToolChangeRejection =
  | 'model_unsupported'
  | 'block_type_unknown'
  | 'header_rejected'
  | 'after_paused_turn'
  | 'too_many_definitions'
  | 'pfc_only'
  | 'unknown_tool_reference'
  | 'other'

/** Official `TDe`: why the server rejected a mid-conversation tool change. */
export function classifyToolChangeRejection(
  error: unknown,
): ToolChangeRejection | undefined {
  if (!(error instanceof APIError)) return undefined
  if (error.status === 400 && getErrorCode(error) === TOOL_CHANGES_UNSUPPORTED_CODE) {
    return 'model_unsupported'
  }
  const message = error.message
  if (
    (error.status === 400 || error.status === 422) &&
    hasInputTag(message, /^tool_(addition|removal)$/)
  ) {
    return 'block_type_unknown'
  }
  if (error.status !== 400) return undefined
  if (rejectsBetaHeader(message, MID_CONVERSATION_TOOL_CHANGES_BETA_HEADER)) {
    return 'header_rejected'
  }
  if (!/\btool_addition\b/.test(message) || isCacheControlShapeError(message)) {
    return undefined
  }
  if (message.includes('paused assistant turn')) return 'after_paused_turn'
  if (
    message.includes('not supported on this model') ||
    message.includes('requires a model that supports')
  ) {
    return 'model_unsupported'
  }
  if (message.includes('exceed')) return 'too_many_definitions'
  if (message.includes('PFC-only')) return 'pfc_only'
  if (message.includes('references') || message.includes('names a declared')) {
    return 'unknown_tool_reference'
  }
  return 'other'
}

const SYSTEM_ROLE_MISPLACED =
  /(?:messages\.(\d{1,6}): )?(?:role .{0,2}system.{0,2} must (?:precede an|follow a)|use the top-level .{0,2}system.{0,2} parameter for the initial system prompt)/i
const SYSTEM_ROLE_TEXT_ONLY = /text-only role .{0,2}system.{0,2} messages require/i
const SYSTEM_ROLE_UNKNOWN =
  /(?:unknown variant .{0,2}system\b.{0,2}, expected|Input should be) [\\'"`]{1,2}(?:user|assistant)\b.{0,2} or [\\'"`]{1,2}(?:user|assistant)\b/i
const SYSTEM_ROLE_MENTION = /system messages?\b|role .{0,2}system/i

/**
 * Official `YO`: the server rejected the role:"system" turn or its beta
 * (`mid-conversation-system-2026-04-07`).
 */
export function isSystemTurnRejection(error: unknown): boolean {
  if (!(error instanceof APIError)) return false
  const message = error.message
  if (
    error.status !== 400 &&
    error.status !== 422 &&
    (message.includes('cache_control') ||
      (message.includes(MID_CONVERSATION_SYSTEM_BETA_HEADER) &&
        /anthropic[-_]beta/.test(message)))
  ) {
    return false
  }
  const code = getErrorCode(error)
  if (error.status === 400 && code === TOOL_CHANGES_UNSUPPORTED_CODE) return false
  return (
    code === SYSTEM_TURN_UNSUPPORTED_CODE ||
    rejectsBetaHeader(message, MID_CONVERSATION_SYSTEM_BETA_HEADER) ||
    SYSTEM_ROLE_MISPLACED.test(message) ||
    SYSTEM_ROLE_TEXT_ONLY.test(message) ||
    (message.includes('Unexpected role') && message.includes('input message role')) ||
    SYSTEM_ROLE_UNKNOWN.test(message) ||
    (message.includes('cache_control') && SYSTEM_ROLE_MENTION.test(message)) ||
    (message.includes('not supported') && /role .{0,2}system/i.test(message)) ||
    hasCapabilityRejection(message, 'mid_conv_system')
  )
}
