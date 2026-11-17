import { getSessionId, onBetaHeaderLatchesCleared } from '../bootstrap/state.js'
import type { QuerySource } from '../constants/querySource.js'
import type { Message } from '../types/message.js'
import {
  type AdvisorToolAttachment,
  formatAdvisorModelName,
  getAdvisorAliasOptions,
  getLastAdvisorAttachment,
  getLastAdvisorToolChange,
  hasFullAdvisorAnnouncement,
  isAdvisorEnabled,
  isAdvisorPairingAllowed,
  isAdvisorPairingAllowedByRank,
  isAdvisorPairingAllowedStrict,
  isAdvisorToolAllowed,
  isSameAdvisorModel,
  isValidAdvisorModel,
  modelSupportsAdvisor,
  resolveAdvisorModel,
} from './advisor.js'
import { type ToolChangeSticky, toolChangesRide } from './advisorToolChanges.js'
import {
  getAnthropicApiKeyWithSource,
  getSubscriptionType,
  isClaudeAISubscriber,
} from './auth.js'
import { logForDebugging } from './debug.js'
import { logError } from './log.js'
import {
  getServedModelCatalog,
  hasServedModel,
} from './model/servedModelCatalog.js'
import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from './model/providers.js'

/**
 * The advisor a conversation is pinned to. Set by its first request and kept
 * until /clear or compaction, so changing /advisor mid-conversation never
 * rewrites what the conversation has already been told. With the
 * mid-conversation tool-change beta (`viaToolChange`) the entry is declared
 * deferred and /advisor turns it on and off with tool_addition and
 * tool_removal; `standby` marks an entry declared before any advisor was set,
 * `inFallback` one that fell back to the inline entry after the beta failed.
 */
export type AdvisorHeld = {
  model: string | undefined
  refused?: true
  viaToolChange?: boolean
  standby?: true
  inFallback?: true
}
export type AdvisorCarrier = { held?: AdvisorHeld; toolChanges?: ToolChangeSticky }

/** The carrier's tool-change beta state, created on first use. */
export function getToolChangeSticky(carrier: AdvisorCarrier): ToolChangeSticky {
  return (carrier.toolChanges ??= {})
}

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
  if (!mainCarrier) return
  delete mainCarrier.carrier.held
  delete mainCarrier.carrier.toolChanges
}

// Reset with the per-conversation beta header latches (clearBetaHeaderLatches).
onBetaHeaderLatchesCleared(resetMainAdvisorCarrier)


/** Official `Oin`: the latest advisor_tool attachment, flattened. */
type LastAdvisor = {
  available: boolean
  model: string | undefined
  toolChange: boolean
  byBase: boolean
}

function toLastAdvisor(attachment: AdvisorToolAttachment): LastAdvisor {
  return {
    available: attachment.available,
    model: attachment.model,
    toolChange: attachment.toolChange !== undefined,
    byBase: attachment.available === false && attachment.byBase === true,
  }
}

function getLastAdvisor(messages: readonly Message[]): LastAdvisor | undefined {
  const attachment = getLastAdvisorAttachment(messages)
  return attachment === undefined ? undefined : toLastAdvisor(attachment)
}

/** Official `_gr`. */
function heldFromLast(last: LastAdvisor | undefined): AdvisorHeld | undefined {
  return last === undefined
    ? undefined
    : { model: last.model, viaToolChange: last.toolChange }
}

/** Official `F`: a request for `requestModel` may carry `model`. */
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

/** Official `C`. */
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

/**
 * Official `lTe`: the account can be billed for the model. The served model
 * catalog stands in for official's model access cache.
 */
function canBillStandby(model: string): boolean {
  if (getAPIProvider() !== 'firstParty') return false
  const catalog = getServedModelCatalog()
  if (catalog !== undefined && catalog.config.models.length > 0) {
    return hasServedModel(model)
  }
  if (!isClaudeAISubscriber()) {
    return (
      getAnthropicApiKeyWithSource({ skipRetrievingKeyFromApiKeyHelper: true })
        .source !== 'none'
    )
  }
  const subscription = getSubscriptionType()
  return subscription === 'pro' || subscription === 'max' || subscription === 'team'
}

/**
 * Official `x`: the advisor a conversation without one declares deferred, so
 * turning /advisor on later is a tool_addition rather than a new prefix.
 * Fable is tried last.
 */
function pickStandby(
  requestModel: string,
  configuredModel: string,
): string | undefined {
  if (
    getAPIProvider() !== 'firstParty' ||
    !isFirstPartyAnthropicBaseUrl() ||
    !isAdvisorEnabled() ||
    !modelSupportsAdvisor(requestModel)
  ) {
    return undefined
  }
  const aliases = getAdvisorAliasOptions()
  const ordered = [
    ...aliases.filter(alias => alias !== 'fable'),
    ...aliases.filter(alias => alias === 'fable'),
  ]
  for (const alias of ordered) {
    const model = pickFromSetting(alias, requestModel, configuredModel)
    if (model === undefined || !isAdvisorPairingAllowedStrict(requestModel, model)) {
      continue
    }
    if (canBillStandby(model)) return model
    logForDebugging(
      `[AdvisorTool] No standby advisor entry - this org is not known to serve ${model}`,
    )
    return undefined
  }
  return undefined
}

/** Official `k`: the advisor a conversation starts with. */
function initialHeld(
  setting: string | undefined,
  requestModel: string,
  configuredModel: string,
  rides: boolean,
): AdvisorHeld {
  const model = pickFromSetting(setting, requestModel, configuredModel)
  if (model !== undefined || !rides || setting) {
    return { model, viaToolChange: rides }
  }
  const standby = pickStandby(requestModel, configuredModel)
  return standby === undefined
    ? { model: undefined, viaToolChange: true }
    : { model: standby, viaToolChange: true, standby: true }
}

/** Official `_`: without the beta the entry is declared inline. */
function rideNow(held: AdvisorHeld, rides: boolean): AdvisorHeld {
  return held.viaToolChange && !rides ? { ...held, viaToolChange: false } : held
}

type AdvisorEntry = {
  advisorModel: string | undefined
  advisorDeferred: boolean
  advisorActive: boolean
}

const NO_ENTRY: AdvisorEntry = {
  advisorModel: undefined,
  advisorDeferred: false,
  advisorActive: false,
}

/** Official `H`. */
function entry(model: string, deferred: boolean, active: boolean): AdvisorEntry {
  return { advisorModel: model, advisorDeferred: deferred, advisorActive: active }
}

/** Official `S`: the entry this request declares. */
function settleEntry(
  held: AdvisorHeld,
  last: LastAdvisor | undefined,
  requestModel: string,
  configuredModel: string,
): AdvisorEntry {
  if (held.model === undefined || !canCarry(held.model, requestModel, configuredModel)) {
    return NO_ENTRY
  }
  if (held.viaToolChange) return entry(held.model, true, last?.available === true)
  if (held.standby && last === undefined) return NO_ENTRY
  if (last !== undefined && !last.available && last.toolChange && !last.byBase) {
    return NO_ENTRY
  }
  return entry(held.model, false, true)
}

const ADVISOR: AdvisorToolAttachment['type'] = 'advisor_tool'

/** Official `D`: the advisor_tool attachment this request adds, if any. */
function getAnnouncement(
  attachments: readonly Message[],
  setting: string | undefined,
  requestModel: string,
  configuredModel: string,
  heldNow: AdvisorHeld | undefined,
  removeOnFallback = false,
): AdvisorToolAttachment | undefined {
  const last = getLastAdvisor(attachments)
  const held = heldNow ??
    heldFromLast(last) ?? {
      model: pickFromSetting(setting, requestModel, configuredModel),
      viaToolChange: false,
    }
  const model = held.model
  const lastAdded = getLastAdvisorToolChange(attachments) === 'add'
  if (model === undefined || !canCarry(model, requestModel, configuredModel)) {
    const viaToolChange = held.viaToolChange || removeOnFallback
    const configured = isAdvisorEnabled() && Boolean(setting)
    if (last?.available !== true) {
      if (!viaToolChange || model === undefined || last === undefined) return undefined
      if (last.byBase && !configured) {
        return { type: ADVISOR, available: false, model, toolChange: 'remove' }
      }
      if (last.toolChange && !last.byBase && configured) {
        return { type: ADVISOR, available: false, model, toolChange: 'remove', byBase: true }
      }
      return undefined
    }
    if (model === undefined) return { type: ADVISOR, available: false }
    if (!viaToolChange) return { type: ADVISOR, available: false, model, byBase: true }
    return configured
      ? { type: ADVISOR, available: false, model, toolChange: 'remove', byBase: true }
      : { type: ADVISOR, available: false, model, toolChange: 'remove' }
  }
  const hasFull = hasFullAdvisorAnnouncement(attachments)
  if (held.viaToolChange) {
    if (resolveAdvisorModel(setting, requestModel) === undefined) {
      return lastAdded || last?.available === true
        ? { type: ADVISOR, available: false, model, toolChange: 'remove' }
        : undefined
    }
    if (lastAdded && last?.available !== false) {
      return hasFull ? undefined : { type: ADVISOR, available: true, model, toolChange: 'add' }
    }
    return hasFull
      ? { type: ADVISOR, available: true, model, abbreviated: true, toolChange: 'add' }
      : { type: ADVISOR, available: true, model, toolChange: 'add' }
  }
  const full: AdvisorToolAttachment = { type: ADVISOR, available: true, model }
  const abbreviated: AdvisorToolAttachment = { ...full, abbreviated: true }
  if (removeOnFallback) {
    if (resolveAdvisorModel(setting, requestModel) === undefined) {
      return last?.available === true ||
        (last !== undefined && last.byBase) ||
        (last === undefined && held.standby !== true)
        ? { type: ADVISOR, available: false, model, toolChange: 'remove' }
        : undefined
    }
    if (last?.available === true) return hasFull ? undefined : full
    return hasFull ? abbreviated : full
  }
  if (last === undefined) return held.standby ? undefined : full
  if (last.available) return hasFull ? undefined : full
  if (last.toolChange && !last.byBase) return undefined
  return hasFull ? abbreviated : full
}

export type AdvisorQueryResolution = AdvisorEntry & {
  announcement?: AdvisorToolAttachment
}

/**
 * The advisor entry a request declares and the conversation's tool-change
 * beta state. A fork sends exactly its parent's.
 */
export type AdvisorRequest = AdvisorEntry & { toolChanges?: ToolChangeSticky }

export const NO_ADVISOR_REQUEST: AdvisorRequest = NO_ENTRY

export function toAdvisorRequest(
  { advisorModel, advisorDeferred, advisorActive }: AdvisorEntry,
  carrier: AdvisorCarrier,
): AdvisorRequest {
  return {
    advisorModel,
    advisorDeferred,
    advisorActive,
    toolChanges: getToolChangeSticky(carrier),
  }
}

/**
 * Official 2.1.325 per-request advisor state (`ggr`). `messages` are the
 * ones after the last compact boundary. `toolChangesRide` says whether a
 * request for the given model carries the mid-conversation tool-change beta.
 */
export function resolveAdvisorForQuery(
  messages: readonly Message[],
  {
    querySource,
    setting,
    configuredModel,
    requestModel,
    carrier,
    toolChangesRide = false,
  }: {
    querySource: QuerySource
    setting: string | undefined
    configuredModel: string
    requestModel: string
    carrier: AdvisorCarrier | undefined
    toolChangesRide?: boolean | ((model: string) => boolean)
  },
): AdvisorQueryResolution {
  try {
    const rides =
      typeof toolChangesRide === 'function'
        ? toolChangesRide
        : () => toolChangesRide
    const kind = getAdvisorQueryKind(querySource)
    const pairedModel = kind === 'main' ? configuredModel : requestModel
    const ridesNow = rides(requestModel)
    const attachments = messages.filter(
      m => m.type === 'attachment' && m.attachment.type === 'advisor_tool',
    )
    const last = getLastAdvisor(attachments)
    if (kind === 'auxiliary') {
      const held =
        carrier?.held ??
        heldFromLast(last) ??
        initialHeld(setting, pairedModel, configuredModel, rides(pairedModel))
      const settled: AdvisorHeld =
        held.model === undefined && ridesNow && !held.refused
          ? {
              model: pickFromSetting(setting, pairedModel, configuredModel),
              viaToolChange: true,
            }
          : held
      return settleEntry(rideNow(settled, ridesNow), last, pairedModel, configuredModel)
    }
    let held = carrier?.held
    if (held === undefined) {
      held =
        heldFromLast(last) ??
        initialHeld(setting, pairedModel, configuredModel, rides(pairedModel))
      if (carrier) carrier.held = held
    } else if (held.model === undefined && ridesNow && !held.refused) {
      const model = pickFromSetting(setting, pairedModel, configuredModel)
      if (model !== undefined) {
        held = { model, viaToolChange: true }
        if (carrier) carrier.held = held
      }
    }
    const heldNow = rideNow(held, ridesNow)
    const removeOnFallback =
      held.viaToolChange === true && !ridesNow && held.inFallback !== true
    const announcement = getAnnouncement(
      attachments,
      setting,
      pairedModel,
      configuredModel,
      heldNow,
      removeOnFallback,
    )
    const settled =
      held.model === undefined ||
      last !== undefined ||
      canCarry(held.model, pairedModel, configuredModel)
    const inFallback = ridesNow ? false : held.inFallback === true || settled
    if (carrier && held.viaToolChange && (held.inFallback === true) !== inFallback) {
      const { inFallback: _, ...rest } = held
      carrier.held = inFallback ? { ...rest, inFallback: true } : rest
    }
    const lastNow = announcement === undefined ? last : toLastAdvisor(announcement)
    return {
      ...settleEntry(heldNow, lastNow, pairedModel, configuredModel),
      announcement,
    }
  } catch (error) {
    logError(error)
    return { ...NO_ENTRY, announcement: undefined }
  }
}

/**
 * Official `MLt` for the held advisor: after the tool-change beta failed, an
 * active deferred entry is declared inline from here on.
 */
export function markAdvisorToolChangeFallback(carrier: AdvisorCarrier): void {
  const held = carrier.held
  if (held?.viaToolChange && held.inFallback !== true) {
    carrier.held = { ...held, inFallback: true }
  }
}

/**
 * Explains, after /advisor changes the setting, which advisor the current
 * conversation keeps (official `y()` in the /advisor setter).
 */
export function describeHeldAdvisor(
  messages: readonly Message[],
  newAdvisor: string | undefined,
  mainModel: string,
): string {
  const carrier = getMainAdvisorCarrier()
  const held = carrier.held ?? heldFromLast(getLastAdvisor(messages))
  if (held === undefined) return ''
  if (held.refused) {
    return newAdvisor === undefined
      ? ''
      : '\nThe API refused the advisor for the current conversation, so it runs without one until /clear or /compact; the setting applies from there and in new conversations.'
  }
  const rides = toolChangesRide(carrier.toolChanges, mainModel)
  if (held.model === undefined && rides) return ''
  if (
    held.viaToolChange &&
    (rides || (held.inFallback !== true && held.model !== undefined))
  ) {
    return held.model !== undefined &&
      newAdvisor !== undefined &&
      !isSameAdvisorModel(newAdvisor, held.model)
      ? `\nThe current conversation keeps ${formatAdvisorModelName(held.model)} as its advisor model until /clear or /compact, so the tool it has already declared stays unchanged; turning the advisor on or off applies right away.`
      : ''
  }
  const last = getLastAdvisor(messages)
  const removed =
    last !== undefined && !last.available && last.toolChange && !last.byBase
  const standbyOnly = held.standby === true && last === undefined
  const model = removed || standbyOnly ? undefined : held.model
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
