import { getSessionId, onBetaHeaderLatchesCleared } from '../bootstrap/state.js'
import type { QuerySource } from '../constants/querySource.js'
import type { Message } from '../types/message.js'
import {
  type AdvisorToolAttachment,
  formatAdvisorModelName,
  getLastAdvisorAttachment,
  hasFullAdvisorAnnouncement,
  isAdvisorPairingAllowed,
  isAdvisorPairingAllowedByRank,
  isAdvisorToolAllowed,
  isSameAdvisorModel,
  isValidAdvisorModel,
  modelSupportsAdvisor,
  resolveAdvisorModel,
} from './advisor.js'
import { logError } from './log.js'

/**
 * The advisor a conversation is pinned to. Set by its first request and kept
 * until /clear or compaction, so changing /advisor mid-conversation never
 * rewrites what the conversation has already been told.
 */
export type AdvisorHeld = { model: string | undefined; refused?: true }
export type AdvisorCarrier = { held?: AdvisorHeld }

type AdvisorQueryKind = 'main' | 'subagent' | 'auxiliary'

export function getAdvisorQueryKind(querySource: QuerySource): AdvisorQueryKind {
  if (querySource.startsWith('repl_main_thread') || querySource === 'sdk') {
    return 'main'
  }
  if (querySource.startsWith('agent:') || querySource === 'hook_agent') {
    return 'subagent'
  }
  return 'auxiliary'
}

let mainCarrier: { sessionId: string; carrier: AdvisorCarrier } | undefined

/** The main thread's carrier; a new session (/clear, resume) starts empty. */
export function getMainAdvisorCarrier(): AdvisorCarrier {
  const sessionId = getSessionId()
  if (mainCarrier?.sessionId !== sessionId) {
    mainCarrier = { sessionId, carrier: {} }
  }
  return mainCarrier.carrier
}

/**
 * /clear and /compact start the conversation over, so it settles its advisor
 * again. Like official, a conversation-scope refusal ends here too; process
 * and host refusals live in advisor.ts and outlast it.
 */
export function resetMainAdvisorCarrier(): void {
  if (mainCarrier) delete mainCarrier.carrier.held
}

// Reset with the per-conversation beta header latches (clearBetaHeaderLatches).
onBetaHeaderLatchesCleared(resetMainAdvisorCarrier)

function heldFromAttachment(
  attachment: AdvisorToolAttachment | undefined,
): AdvisorHeld | undefined {
  return attachment === undefined ? undefined : { model: attachment.model }
}

function canCarry(model: string, requestModel: string, configuredModel: string) {
  return (
    isAdvisorToolAllowed() &&
    isValidAdvisorModel(model) &&
    modelSupportsAdvisor(requestModel) &&
    (isSameAdvisorModel(requestModel, configuredModel)
      ? isAdvisorPairingAllowed(requestModel, model)
      : isAdvisorPairingAllowedByRank(requestModel, model))
  )
}

function pickFromSetting(
  setting: string | undefined,
  requestModel: string,
  configuredModel: string,
): string | undefined {
  const advisor = resolveAdvisorModel(setting, requestModel)
  return advisor !== undefined &&
    (isSameAdvisorModel(requestModel, configuredModel) ||
      isAdvisorPairingAllowedByRank(requestModel, advisor))
    ? advisor
    : undefined
}

function getAnnouncement(
  attachments: readonly Message[],
  held: AdvisorHeld,
  requestModel: string,
  configuredModel: string,
): AdvisorToolAttachment | undefined {
  const last = getLastAdvisorAttachment(attachments)
  const model = held.model
  if (model === undefined || !canCarry(model, requestModel, configuredModel)) {
    if (last?.available !== true) return undefined
    return model === undefined
      ? { type: 'advisor_tool', available: false }
      : { type: 'advisor_tool', available: false, model, byBase: true }
  }
  const full: AdvisorToolAttachment = { type: 'advisor_tool', available: true, model }
  const hasFull = hasFullAdvisorAnnouncement(attachments)
  if (last === undefined) return full
  if (last.available) return hasFull ? undefined : full
  return hasFull ? { ...full, abbreviated: true } : full
}

export type AdvisorQueryResolution = {
  announcement?: AdvisorToolAttachment
  advisorModel?: string
}

/**
 * Official 2.1.325 per-request advisor state (without the mid-conversation
 * tool-change beta, which this build never sends). `messages` are the ones
 * after the last compact boundary.
 */
export function resolveAdvisorForQuery(
  messages: readonly Message[],
  {
    querySource,
    setting,
    configuredModel,
    requestModel,
    carrier,
  }: {
    querySource: QuerySource
    setting: string | undefined
    configuredModel: string
    requestModel: string
    carrier: AdvisorCarrier | undefined
  },
): AdvisorQueryResolution {
  try {
    const kind = getAdvisorQueryKind(querySource)
    const pairedModel = kind === 'main' ? configuredModel : requestModel
    const attachments = messages.filter(
      m => m.type === 'attachment' && m.attachment.type === 'advisor_tool',
    )
    const last = getLastAdvisorAttachment(attachments)
    let held = carrier?.held
    if (held === undefined) {
      held = heldFromAttachment(last) ?? {
        model: pickFromSetting(setting, pairedModel, configuredModel),
      }
      if (kind !== 'auxiliary' && carrier !== undefined) carrier.held = held
    }
    const announcement =
      kind === 'auxiliary'
        ? undefined
        : getAnnouncement(attachments, held, pairedModel, configuredModel)
    const model = held.model
    const advisorModel =
      model !== undefined && canCarry(model, pairedModel, configuredModel)
        ? model
        : undefined
    return { announcement, advisorModel }
  } catch (error) {
    logError(error)
    return {}
  }
}

/**
 * Explains, after /advisor changes the setting, which advisor the current
 * conversation keeps (official `y()` in the /advisor setter).
 */
export function describeHeldAdvisor(
  messages: readonly Message[],
  newAdvisor: string | undefined,
): string {
  const held =
    getMainAdvisorCarrier().held ??
    heldFromAttachment(getLastAdvisorAttachment(messages))
  if (held === undefined) return ''
  if (held.refused) {
    return newAdvisor === undefined
      ? ''
      : '\nThe API refused the advisor for the current conversation, so it runs without one until /clear or /compact; the setting applies from there and in new conversations.'
  }
  const model = held.model
  if (
    model === newAdvisor ||
    (model !== undefined &&
      newAdvisor !== undefined &&
      isSameAdvisorModel(newAdvisor, model))
  ) {
    return ''
  }
  return `\nThe current conversation ${model === undefined ? 'runs without the advisor' : `keeps ${formatAdvisorModelName(model)} as its advisor`} until /clear or /compact, so the prompt it has already sent stays unchanged; the new setting applies from there and in new conversations.`
}
