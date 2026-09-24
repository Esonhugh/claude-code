// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { getIsInteractive, getSdkBetas } from '../bootstrap/state.js'
import { CONTEXT_1M_BETA_HEADER } from '../constants/betas.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { getSubscriptionType } from './auth.js'
import { getGlobalConfig } from './config.js'
import { isEnvTruthy } from './envUtils.js'
import { getCanonicalName } from './model/model.js'
import { getModelCapability } from './model/modelCapabilities.js'
import { isAnt } from 'src/utils/userType.js'


function isOpenAI1MModel(model: string): boolean {
  return /^(gpt-5\.6-(sol|terra|luna)|gpt-6-astra)(\[1m\])?$/i.test(model)
}

const MODEL_DEFAULT_COMPACTION_WINDOW = 200_000
const MIN_COMPACTION_WINDOW = 100_000
const MAX_COMPACTION_WINDOW = 1_000_000

function parseCompactionWindow(value: unknown): number | undefined {
  let result: number
  if (typeof value === 'number') result = value
  else if (typeof value !== 'string') return undefined
  else {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'auto') return undefined
    const match = normalized.match(/^(\d+(?:\.\d+)?)([km])?$/)
    if (!match) return undefined
    result = Number(match[1])
    if (match[2] === 'm') result *= 1_000_000
    else if (match[2] === 'k') result *= 1_000
    else if (!normalized.includes('.') && result >= 100 && result <= 1_000)
      result *= 1_000
  }
  if (
    !Number.isFinite(result) ||
    result < MIN_COMPACTION_WINDOW ||
    result > MAX_COMPACTION_WINDOW
  ) return undefined
  return Math.round(result)
}

function selectCompactionWindow(value: unknown): number | undefined {
  if (typeof value === 'number') return parseCompactionWindow(value)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const surface = process.env.CLAUDE_CODE_ENTRYPOINT
  const selectedSurface = surface && record.surfaces &&
    typeof record.surfaces === 'object' && !Array.isArray(record.surfaces)
      ? (record.surfaces as Record<string, unknown>)[surface]
      : undefined
  const tier = getSubscriptionType()
  const select = (candidate: unknown): unknown => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      return candidate
    const options = candidate as Record<string, unknown>
    return tier && Object.hasOwn(options, tier) ? options[tier] : options.default
  }
  const surfaceWindow = selectCompactionWindow(selectedSurface)
  return surfaceWindow ?? parseCompactionWindow(select(record))
}

function clientDataCompactionWindow(model: string): {
  window?: number
  source?: 'clientdata' | 'model-default'
  replacesDefault: boolean
} {
  const config = getGlobalConfig()
  const read = (source: unknown): { window?: number; present: boolean } => {
    if (!source || typeof source !== 'object' || Array.isArray(source))
      return { present: false }
    const record = source as Record<string, unknown>
    if (!Object.hasOwn(record, model)) return { present: false }
    return { window: selectCompactionWindow(record[model]), present: true }
  }
  const current = read(
    config.clientDataCache?.rowan_thicket,
  )
  const fallback = read(config.autoCompactWindowsCache)
  return {
    window: current.window ?? (current.present ? undefined : fallback.window),
    source: current.window !== undefined
      ? 'clientdata'
      : !current.present && fallback.window !== undefined
        ? 'model-default'
        : undefined,
    replacesDefault: current.present || fallback.present,
  }
}

function experimentCompactionWindow(model: string): number | undefined {
  if (!getIsInteractive() || getCanonicalName(model) !== 'claude-opus-4-8')
    return undefined
  const value =
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_redwood2', '') ||
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_redwood3', '')
  return parseCompactionWindow(value)
}

// Conservative fallback for models without known limits.
export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000

export type ContextWindowSource =
  | 'env'
  | 'settings'
  | 'clientdata'
  | 'experiment'
  | 'model-default'
  | 'unknown-model'
  | 'auto'

// Maximum output tokens for compact operations
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000

// Default max output tokens
const MAX_OUTPUT_TOKENS_DEFAULT = 32_000
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 64_000

// Capped default for slot-reservation optimization. BQ p99 output = 4,911
// tokens, so 32k/64k defaults over-reserve 8-16× slot capacity. With the cap
// enabled, <1% of requests hit the limit; those get one clean retry at 64k
// (see query.ts max_output_tokens_escalate). Cap is applied in
// claude.ts:getMaxOutputTokensForModel to avoid the growthbook→betas→context
// import cycle.
export const CAPPED_DEFAULT_MAX_TOKENS = 8_000
export const ESCALATED_MAX_TOKENS = 64_000

/**
 * Check if 1M context is disabled via environment variable.
 * Used by C4E admins to disable 1M context for HIPAA compliance.
 */
export function is1mContextDisabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT)
}

export function has1mContext(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  return /\[1m\]/i.test(model)
}

// @[MODEL LAUNCH]: Update this pattern if the new model supports 1M context
export function modelSupports1M(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  const canonical = getCanonicalName(model)
  return (
    canonical === 'claude-opus-5' ||
    canonical === 'claude-sonnet-5' ||
    canonical.includes('claude-sonnet-4') ||
    canonical.includes('opus-4-6')
  )
}

export function getContextWindowForModel(
  model: string,
  betas?: string[],
): number {
  // Allow override via environment variable (ant-only)
  // This takes precedence over all other context window resolution, including 1M detection,
  // so users can cap the effective context window for local decisions (auto-compact, etc.)
  // while still using a 1M-capable endpoint.
  if (
    isAnt() &&
    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  ) {
    const override = parseInt(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, 10)
    if (!isNaN(override) && override > 0) {
      return override
    }
  }

  // [1m] is a client-side opt-in, not permission to exceed an API input limit.
  if (has1mContext(model)) {
    return isOpenAI1MModel(model) ? 922_000 : 1_000_000
  }

  const cap = getModelCapability(model)
  if (cap?.max_input_tokens && cap.max_input_tokens >= 100_000) {
    if (
      cap.max_input_tokens > MODEL_CONTEXT_WINDOW_DEFAULT &&
      is1mContextDisabled()
    ) {
      return MODEL_CONTEXT_WINDOW_DEFAULT
    }
    return cap.max_input_tokens
  }

  const canonical = getCanonicalName(model)
  if (canonical === 'claude-opus-5' || canonical === 'claude-sonnet-5') {
    return is1mContextDisabled() ? MODEL_CONTEXT_WINDOW_DEFAULT : 1_000_000
  }
  if (isOpenAI1MModel(model)) {
    // Official total window is 1,050,000: input 922,000 + output 128,000.
    // Local compaction decisions must use the input ceiling, not the total.
    return is1mContextDisabled() ? MODEL_CONTEXT_WINDOW_DEFAULT : 922_000
  }

  if (betas?.includes(CONTEXT_1M_BETA_HEADER) && modelSupports1M(model)) {
    return 1_000_000
  }
  if (getSonnet1mExpTreatmentEnabled(model)) {
    return 1_000_000
  }
  if (isAnt()) {
    // @ts-ignore - recovered code
    const antModel = resolveAntModel(model)
    if (antModel?.contextWindow) {
      return antModel.contextWindow
    }
  }
  return MODEL_CONTEXT_WINDOW_DEFAULT
}

export function resolveContextWindow(
  model: string,
  settingsWindow?: number,
): { window: number; source: ContextWindowSource } {
  const modelWindow = getContextWindowForModel(model, getSdkBetas())
  const configuredWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW

  if (configuredWindow) {
    const parsed = parseCompactionWindow(configuredWindow)
    if (parsed !== undefined) {
      return { window: Math.min(modelWindow, parsed), source: 'env' }
    }
  }

  if (settingsWindow !== undefined) {
    return { window: Math.min(modelWindow, settingsWindow), source: 'settings' }
  }

  const canonical = getCanonicalName(model)
  const clientData = clientDataCompactionWindow(canonical)
  if (clientData.window !== undefined) {
    return {
      window: Math.min(modelWindow, clientData.window),
      source: clientData.source!,
    }
  }

  const experiment = experimentCompactionWindow(model)
  if (experiment !== undefined) {
    return {
      window: Math.min(modelWindow, experiment),
      source: 'experiment',
    }
  }

  if (modelWindow < 1_000_000 && modelSupports1M(model)) {
    return {
      window: Math.min(modelWindow, MODEL_DEFAULT_COMPACTION_WINDOW),
      source: 'model-default',
    }
  }

  if (!clientData.replacesDefault) {
    const fallback = canonical === 'claude-sonnet-5'
      ? selectCompactionWindow({
          default: 967_000,
          surfaces: {
            remote_cowork: { default: 500_000 },
            'local-agent': { default: 500_000 },
          },
        })
      : undefined
    if (fallback !== undefined) {
      return {
        window: Math.min(modelWindow, fallback),
        source: 'model-default',
      }
    }
  }

  return { window: modelWindow, source: 'auto' }
}

export function getSonnet1mExpTreatmentEnabled(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  // Only applies to sonnet 4.6 without an explicit [1m] suffix
  if (has1mContext(model)) {
    return false
  }
  if (!getCanonicalName(model).includes('sonnet-4-6')) {
    return false
  }
  return getGlobalConfig().clientDataCache?.['coral_reef_sonnet'] === 'true'
}

/**
 * Calculate context window usage percentage from token usage data.
 * Returns used and remaining percentages, or null values if no usage data.
 */
export function calculateContextPercentages(
  currentUsage: {
    input_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  } | null,
  contextWindowSize: number,
): { used: number | null; remaining: number | null } {
  if (!currentUsage) {
    return { used: null, remaining: null }
  }

  const totalInputTokens =
    currentUsage.input_tokens +
    currentUsage.cache_creation_input_tokens +
    currentUsage.cache_read_input_tokens

  const usedPercentage = Math.round(
    (totalInputTokens / contextWindowSize) * 100,
  )
  const clampedUsed = Math.min(100, Math.max(0, usedPercentage))

  return {
    used: clampedUsed,
    remaining: 100 - clampedUsed,
  }
}

/**
 * Returns the model's default and upper limit for max output tokens.
 */
export function getModelMaxOutputTokens(model: string): {
  default: number
  upperLimit: number
} {
  let defaultTokens: number
  let upperLimit: number

  if (isAnt()) {
    // @ts-ignore - recovered code
    const antModel = resolveAntModel(model.toLowerCase())
    if (antModel) {
      defaultTokens = antModel.defaultMaxTokens ?? MAX_OUTPUT_TOKENS_DEFAULT
      upperLimit = antModel.upperMaxTokensLimit ?? MAX_OUTPUT_TOKENS_UPPER_LIMIT
      return { default: defaultTokens, upperLimit }
    }
  }

  const m = getCanonicalName(model)

  if (m === 'claude-opus-5' || m === 'claude-sonnet-5' || isOpenAI1MModel(model)) {
    defaultTokens = MAX_OUTPUT_TOKENS_DEFAULT
    upperLimit = 128_000
  } else if (m.includes('opus-4-6')) {
    defaultTokens = 64_000
    upperLimit = 128_000
  } else if (m.includes('sonnet-4-6')) {
    defaultTokens = 32_000
    upperLimit = 128_000
  } else if (
    m.includes('opus-4-5') ||
    m.includes('sonnet-4') ||
    m.includes('haiku-4')
  ) {
    defaultTokens = 32_000
    upperLimit = 64_000
  } else if (m.includes('opus-4-1') || m.includes('opus-4')) {
    defaultTokens = 32_000
    upperLimit = 32_000
  } else if (m.includes('claude-3-opus')) {
    defaultTokens = 4_096
    upperLimit = 4_096
  } else if (m.includes('claude-3-sonnet')) {
    defaultTokens = 8_192
    upperLimit = 8_192
  } else if (m.includes('claude-3-haiku')) {
    defaultTokens = 4_096
    upperLimit = 4_096
  } else if (m.includes('3-5-sonnet') || m.includes('3-5-haiku')) {
    defaultTokens = 8_192
    upperLimit = 8_192
  } else if (m.includes('3-7-sonnet')) {
    defaultTokens = 32_000
    upperLimit = 64_000
  } else {
    defaultTokens = MAX_OUTPUT_TOKENS_DEFAULT
    upperLimit = MAX_OUTPUT_TOKENS_UPPER_LIMIT
  }

  const cap = getModelCapability(model)
  if (cap?.max_tokens && cap.max_tokens >= 4_096) {
    upperLimit = cap.max_tokens
    defaultTokens = Math.min(defaultTokens, upperLimit)
  }

  return { default: defaultTokens, upperLimit }
}

/**
 * Returns the max thinking budget tokens for a given model. The max
 * thinking tokens should be strictly less than the max output tokens.
 *
 * Deprecated since newer models use adaptive thinking rather than a
 * strict thinking token budget.
 */
export function getMaxThinkingTokensForModel(model: string): number {
  return getModelMaxOutputTokens(model).upperLimit - 1
}
