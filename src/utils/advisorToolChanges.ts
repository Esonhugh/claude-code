import {
  MID_CONVERSATION_SYSTEM_BETA_HEADER,
  MID_CONVERSATION_TOOL_CHANGES_BETA_HEADER,
} from '../constants/betas.js'
import type { ToolChangeRejection } from '../services/api/advisorRefusal.js'
import {
  getAdvisorHostKey,
  isAdvisorToolAllowed,
  resolveAdvisorModelId,
} from './advisor.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import { getCanonicalName, isModelOlderThan } from './model/model.js'
import { getAPIProvider } from './model/providers.js'

/**
 * Per-conversation state of the mid-conversation tool-change beta (official
 * sticky betas for `mid-conversation-tool-changes-2026-07-01`). Once sent it
 * keeps being sent; a rejection keeps it off. Both last until /clear or
 * /compact.
 */
export type ToolChangeSticky = {
  sent?: true
  rejected?: true
  /** The server rejected the role:"system" turn (`mid-conversation-system`). */
  systemRejected?: true
}

// @[MODEL LAUNCH]: Add the model if its catalog row lacks `mid_conv_tool_change`.
const NO_TOOL_CHANGE_MODELS = [
  'haiku-4-5',
  'sonnet-4-6',
  'opus-4-6',
  'sonnet-5',
  'opus-4-7',
]

// After a catalog key the id may only end, open a `[1m]` style suffix, or
// carry an 8-digit snapshot date: `claude-sonnet-5-5` is not `sonnet-5`.
const CATALOG_KEY_TAIL = /^(?:$|\[|-\d{8}(?:$|\[))/

function isCatalogModel(id: string, key: string): boolean {
  for (let at = id.indexOf(key); at !== -1; at = id.indexOf(key, at + 1)) {
    const before = id[at - 1]
    if (before !== undefined && /[a-z0-9]/.test(before)) continue
    if (CATALOG_KEY_TAIL.test(id.slice(at + key.length))) return true
  }
  return false
}

// Official host latch `toolChangeHeaderRefused`, keyed here by the base URL
// host like the advisor's host refusal.
const refusedHosts = new Set<string>()
// Official `toolChangeUnsupportedModels`.
const unsupportedModels = new Set<string>()

function getModelKey(model: string): string {
  return resolveAdvisorModelId(model).toLowerCase().replace(/\[\w+\]$/, '')
}

function isForced(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_FORCE_MID_CONVERSATION_SYSTEM)
}

/** Official `AS`/`FC`: the model takes role:"system" turns. */
function modelSupportsSystemTurns(model: string): boolean {
  if (isForced()) return true
  return !isModelOlderThan(getCanonicalName(model), 'claude-opus-4-8')
}

/**
 * Official `F_e`: the model takes mid-conversation tool changes. A model
 * missing from the catalog is assumed to.
 */
export function modelSupportsToolChanges(model: string): boolean {
  if (
    getAPIProvider() !== 'firstParty' ||
    isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS) ||
    !modelSupportsSystemTurns(model)
  ) {
    return false
  }
  if (isForced()) return true
  if (unsupportedModels.has(getModelKey(model))) return false
  const id = resolveAdvisorModelId(model).toLowerCase()
  return !NO_TOOL_CHANGE_MODELS.some(key => isCatalogModel(id, key))
}

/** Official `z`: something outside the beta's own state keeps it off. */
function isToolChangeBlocked(sticky: ToolChangeSticky | undefined): boolean {
  return sticky?.systemRejected === true || refusedHosts.has(getAdvisorHostKey())
}

/**
 * Whether getMergedBetas offers the two betas. Official sends them whenever
 * the model takes them (`tengu_foamy_spring`, default on and not read here);
 * this build sends them only for the advisor.
 */
export function shouldOfferToolChangeBetas(model: string): boolean {
  return (
    isAdvisorToolAllowed() &&
    !isToolChangeBlocked(undefined) &&
    modelSupportsToolChanges(model)
  )
}

/** Official `TQ`: the next request for `model` would carry tool changes. */
export function toolChangesRide(
  sticky: ToolChangeSticky | undefined,
  model: string,
): boolean {
  return (
    isAdvisorToolAllowed() &&
    sticky?.rejected !== true &&
    !isToolChangeBlocked(sticky) &&
    modelSupportsToolChanges(model)
  )
}

/**
 * Official `ub`: the next request for `model` sends a notice that never
 * started a turn (a stop notice) as its own role:"system" turn. Official
 * sends these without a beta header and on every provider; this build keeps
 * them to the first-party API, and a request without conversation state
 * keeps the reminder. A rejection keeps them off until /clear or /compact.
 */
export function systemNoticesRide(
  sticky: ToolChangeSticky | undefined,
  model: string,
): boolean {
  return (
    sticky !== undefined &&
    sticky.systemRejected !== true &&
    getAPIProvider() === 'firstParty' &&
    modelSupportsSystemTurns(model)
  )
}

const TOOL_CHANGE_BETAS = [
  MID_CONVERSATION_TOOL_CHANGES_BETA_HEADER,
  MID_CONVERSATION_SYSTEM_BETA_HEADER,
]

/**
 * Official `xna`, in place: mark the beta sent when this request offers it,
 * then keep both betas iff it was sent and is still usable. A request
 * without conversation state (side queries) never carries them.
 */
export function applyToolChangeBetas(
  sticky: ToolChangeSticky | undefined,
  betas: string[],
  model: string,
): void {
  if (
    sticky !== undefined &&
    betas.includes(MID_CONVERSATION_TOOL_CHANGES_BETA_HEADER) &&
    !isToolChangeBlocked(sticky) &&
    sticky.rejected !== true
  ) {
    sticky.sent = true
  }
  const keep =
    sticky?.sent === true &&
    sticky.rejected !== true &&
    !isToolChangeBlocked(sticky) &&
    modelSupportsToolChanges(model)
  for (const header of TOOL_CHANGE_BETAS) {
    const at = betas.indexOf(header)
    if (!keep && at !== -1) betas.splice(at, 1)
    if (keep && at === -1) betas.push(header)
  }
}

function rejectBeta(sticky: ToolChangeSticky | undefined): void {
  if (sticky === undefined) return
  delete sticky.sent
  sticky.rejected = true
}

/** Official `Mna`. */
export function recordToolChangeRejection(
  sticky: ToolChangeSticky | undefined,
  kind: ToolChangeRejection,
  model: string,
): void {
  rejectBeta(sticky)
  if (kind === 'header_rejected' || kind === 'block_type_unknown') {
    refusedHosts.add(getAdvisorHostKey())
  } else if (kind === 'model_unsupported') {
    unsupportedModels.add(getModelKey(model))
  }
  logForDebugging(
    `[late-tool-additions] tool_addition rejected (${kind}) \u2014 falling back to the ToolSearch announcement (or to inline tools where there is no ToolSearch), sticky-rejecting the beta until /clear or /compact`,
    { level: 'warn' },
  )
}

/** Official `YO` handling: no role:"system" turns for this conversation. */
export function recordSystemTurnRejection(
  sticky: ToolChangeSticky | undefined,
): void {
  rejectBeta(sticky)
  if (sticky !== undefined) sticky.systemRejected = true
  logForDebugging(
    '[mid-conv-system] server rejected role:"system" \u2014 falling back to a body with no {role:"system"} turn, sticky-rejecting the beta until /clear or /compact',
    { level: 'warn' },
  )
}

export function resetToolChangeLatchesForTesting(): void {
  refusedHosts.clear()
  unsupportedModels.clear()
}
