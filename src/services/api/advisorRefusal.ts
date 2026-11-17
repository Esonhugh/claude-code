import { APIError } from '@anthropic-ai/sdk'
import { ADVISOR_BETA_HEADER } from '../../constants/betas.js'

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

const ADVISOR_INCOMPATIBLE = 'cannot be used as an advisor when the request model is'
const ADVISOR_INPUT_TAG = new RegExp(
  `^${'advisor_20260301'.replace(/\d+$/, '')}\\d+$`,
)

function hasAdvisorInputTag(message: string): boolean {
  return [...message.matchAll(/Input tag '([\w.-]+)'/g)].some(([, tag]) =>
    ADVISOR_INPUT_TAG.test(tag!),
  )
}

function hasCapabilityRejection(message: string, capability: string): boolean {
  const marker = `capability_rejected: ${capability}`
  for (let at = message.indexOf(marker); at !== -1; at = message.indexOf(marker, at + 1)) {
    const next = message[at + marker.length]
    if (next === undefined || !/[A-Za-z0-9_:.-]/.test(next)) return true
  }
  return false
}

function rejectsAdvisorBeta(error: APIError): boolean {
  const message = error.message
  return (
    error.status === 400 &&
    ((message.includes(ADVISOR_BETA_HEADER) && /anthropic[-_]beta/.test(message)) ||
      hasCapabilityRejection(message, `beta_header:${ADVISOR_BETA_HEADER}`))
  )
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

/** The configured advisor cannot pair with the request model; not retried. */
export function isAdvisorIncompatibleError(error: unknown): error is APIError {
  return (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes(ADVISOR_INCOMPATIBLE)
  )
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

/** Official `Qlt` and `hCn`: whether a retry without the advisor may help. */
export function classifyAdvisorRefusal(
  error: unknown,
  betas: readonly string[],
): AdvisorRefusal | undefined {
  if (!(error instanceof APIError) || isAdvisorIncompatibleError(error)) {
    return undefined
  }
  if (!isAdvisorRefusalError(error)) return undefined
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
