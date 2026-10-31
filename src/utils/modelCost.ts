import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/services/analytics/index.js'
import { logEvent } from 'src/services/analytics/index.js'
import { setHasUnknownModelCost } from '../bootstrap/state.js'
import { isFastModeEnabled } from './fastMode.js'
import { formatTokens } from './format.js'
import {
  CLAUDE_3_5_HAIKU_CONFIG,
  CLAUDE_3_5_V2_SONNET_CONFIG,
  CLAUDE_3_7_SONNET_CONFIG,
  CLAUDE_HAIKU_4_5_CONFIG,
  CLAUDE_HAIKU_5_5_CONFIG,
  CLAUDE_OPUS_4_1_CONFIG,
  CLAUDE_OPUS_4_5_CONFIG,
  CLAUDE_OPUS_4_6_CONFIG,
  CLAUDE_OPUS_4_7_CONFIG,
  CLAUDE_OPUS_4_8_CONFIG,
  CLAUDE_OPUS_4_CONFIG,
  CLAUDE_FABLE_5_CONFIG,
  CLAUDE_FABLE_5_1_CONFIG,
  CLAUDE_MYTHOS_5_CONFIG,
  CLAUDE_MYTHOS_5_1_CONFIG,
  CLAUDE_OPUS_5_5_CONFIG,
  CLAUDE_SONNET_5_5_CONFIG,
  CLAUDE_SONNET_4_5_CONFIG,
  CLAUDE_SONNET_4_6_CONFIG,
  CLAUDE_SONNET_4_CONFIG,
} from './model/configs.js'
import {
  firstPartyNameToCanonical,
  getCanonicalName,
  getDefaultMainLoopModelSetting,
  normalizeModelStringForAPI,
  type ModelShortName,
} from './model/model.js'

// @see https://platform.claude.com/docs/en/about-claude/pricing
export type ModelCosts = {
  inputTokens: number
  outputTokens: number
  promptCacheWriteTokens: number
  promptCacheReadTokens: number
  webSearchRequests: number
  /** Rates that apply once a request's prompt exceeds abovePromptTokens. */
  longPrompt?: Omit<ModelCosts, 'longPrompt'> & { abovePromptTokens: number }
}

// Standard pricing tier for Sonnet models: $3 input / $15 output per Mtok
export const COST_TIER_3_15 = {
  inputTokens: 3,
  outputTokens: 15,
  promptCacheWriteTokens: 3.75,
  promptCacheReadTokens: 0.3,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Pricing tier for Opus 4/4.1: $15 input / $75 output per Mtok
export const COST_TIER_15_75 = {
  inputTokens: 15,
  outputTokens: 75,
  promptCacheWriteTokens: 18.75,
  promptCacheReadTokens: 1.5,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Pricing tier for Opus 4.5: $5 input / $25 output per Mtok
export const COST_TIER_5_25 = {
  inputTokens: 5,
  outputTokens: 25,
  promptCacheWriteTokens: 6.25,
  promptCacheReadTokens: 0.5,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

export const COST_TIER_4_20 = {
  inputTokens: 4,
  outputTokens: 20,
  promptCacheWriteTokens: 5,
  promptCacheReadTokens: 0.2,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

export const COST_TIER_10_50 = {
  inputTokens: 10,
  outputTokens: 50,
  promptCacheWriteTokens: 12.5,
  promptCacheReadTokens: 0.25,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

export const COST_TIER_10_50_LEGACY_CACHE = {
  ...COST_TIER_10_50,
  promptCacheReadTokens: 1,
} as const satisfies ModelCosts

export const COST_TIER_FAST_8_40 = {
  inputTokens: 8,
  outputTokens: 40,
  promptCacheWriteTokens: 10,
  promptCacheReadTokens: 0.4,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

export const COST_TIER_FAST_10_50 = {
  inputTokens: 10,
  outputTokens: 50,
  promptCacheWriteTokens: 12.5,
  promptCacheReadTokens: 1,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Fast mode for Opus 4.6/4.7: $30 input / $150 output per Mtok
export const COST_TIER_FAST_30_150 = {
  inputTokens: 30,
  outputTokens: 150,
  promptCacheWriteTokens: 37.5,
  promptCacheReadTokens: 3,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Pricing for Haiku 3.5: $0.80 input / $4 output per Mtok
export const COST_HAIKU_35 = {
  inputTokens: 0.8,
  outputTokens: 4,
  promptCacheWriteTokens: 1,
  promptCacheReadTokens: 0.08,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Pricing for Haiku 4.5: $1 input / $5 output per Mtok
export const COST_HAIKU_45 = {
  inputTokens: 1,
  outputTokens: 5,
  promptCacheWriteTokens: 1.25,
  promptCacheReadTokens: 0.1,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Pricing for Haiku 5.5: $0.10 input / $0.50 output per Mtok (official 2.1.311 catalog `haiku_55`)
export const COST_HAIKU_55 = {
  inputTokens: 0.1,
  outputTokens: 0.5,
  promptCacheWriteTokens: 0.125,
  promptCacheReadTokens: 0.01,
  webSearchRequests: 0.01,
  longPrompt: {
    abovePromptTokens: 100_000,
    inputTokens: 0.5,
    outputTokens: 2.5,
    promptCacheWriteTokens: 0.625,
    promptCacheReadTokens: 0.05,
    webSearchRequests: 0.01,
  },
} as const satisfies ModelCosts

const DEFAULT_UNKNOWN_MODEL_COST = COST_TIER_5_25

/**
 * Get the cost tier for the current Opus model based on fast mode.
 */
export function getOpusCostTier(fastMode: boolean): ModelCosts {
  if (isFastModeEnabled() && fastMode) {
    return COST_TIER_FAST_8_40
  }
  return COST_TIER_4_20
}

// @[MODEL LAUNCH]: Add a pricing entry for the new model below.
// Costs from https://platform.claude.com/docs/en/about-claude/pricing
// Web search cost: $10 per 1000 requests = $0.01 per request
export const MODEL_COSTS: Record<ModelShortName, ModelCosts> = {
  [firstPartyNameToCanonical(CLAUDE_FABLE_5_1_CONFIG.firstParty)]:
    COST_TIER_10_50,
  [firstPartyNameToCanonical(CLAUDE_FABLE_5_CONFIG.firstParty)]:
    COST_TIER_10_50_LEGACY_CACHE,
  [firstPartyNameToCanonical(CLAUDE_MYTHOS_5_1_CONFIG.firstParty)]:
    COST_TIER_10_50,
  [firstPartyNameToCanonical(CLAUDE_MYTHOS_5_CONFIG.firstParty)]:
    COST_TIER_10_50_LEGACY_CACHE,
  [firstPartyNameToCanonical(CLAUDE_OPUS_5_5_CONFIG.firstParty)]: COST_TIER_4_20,
  'claude-opus-5': COST_TIER_5_25,
  [firstPartyNameToCanonical(CLAUDE_SONNET_5_5_CONFIG.firstParty)]: {
    inputTokens: 2,
    outputTokens: 10,
    promptCacheWriteTokens: 2.5,
    promptCacheReadTokens: 0.1,
    webSearchRequests: 0.01,
  },
  'claude-sonnet-5': {
    inputTokens: 2,
    outputTokens: 10,
    promptCacheWriteTokens: 2.5,
    promptCacheReadTokens: 0.2,
    webSearchRequests: 0.01,
  },
  // OpenAI has no separate cache-write surcharge; uncached input uses the base rate.
  // Verified 2026-09-19: Sol promotional pricing lasts at least through 2026-11-21.
  'gpt-5.6-sol': {
    inputTokens: 4,
    outputTokens: 20,
    promptCacheWriteTokens: 4,
    promptCacheReadTokens: 0.4,
    webSearchRequests: 0.01,
  },
  'gpt-6-astra': {
    inputTokens: 10,
    outputTokens: 50,
    promptCacheWriteTokens: 10,
    promptCacheReadTokens: 1,
    webSearchRequests: 0.01,
  },
  'gpt-5.6-terra': {
    inputTokens: 2,
    outputTokens: 12,
    promptCacheWriteTokens: 2,
    promptCacheReadTokens: 0.2,
    webSearchRequests: 0.01,
  },
  'gpt-5.6-luna': {
    inputTokens: 0.2,
    outputTokens: 1.2,
    promptCacheWriteTokens: 0.2,
    promptCacheReadTokens: 0.02,
    webSearchRequests: 0.01,
  },
  [firstPartyNameToCanonical(CLAUDE_3_5_HAIKU_CONFIG.firstParty)]:
    COST_HAIKU_35,
  [firstPartyNameToCanonical(CLAUDE_HAIKU_4_5_CONFIG.firstParty)]:
    COST_HAIKU_45,
  [firstPartyNameToCanonical(CLAUDE_HAIKU_5_5_CONFIG.firstParty)]:
    COST_HAIKU_55,
  [firstPartyNameToCanonical(CLAUDE_3_5_V2_SONNET_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_3_7_SONNET_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_SONNET_4_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_SONNET_4_5_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_SONNET_4_6_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_CONFIG.firstParty)]: COST_TIER_15_75,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_1_CONFIG.firstParty)]:
    COST_TIER_15_75,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_5_CONFIG.firstParty)]:
    COST_TIER_5_25,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_6_CONFIG.firstParty)]:
    COST_TIER_5_25,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_7_CONFIG.firstParty)]:
    COST_TIER_5_25,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_8_CONFIG.firstParty)]:
    COST_TIER_5_25,
}

/**
 * Calculates the USD cost based on token usage and model cost configuration
 */
function tokensToUSDCost(costs: ModelCosts, usage: Usage): number {
  const promptTokens =
    usage.input_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  const modelCosts =
    costs.longPrompt && promptTokens > costs.longPrompt.abovePromptTokens
      ? costs.longPrompt
      : costs
  // 1h cache writes are billed at 2x the base input rate (official 2.1.311).
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0
  const cacheWrite1hTokens = Math.min(
    Math.max(usage.cache_creation?.ephemeral_1h_input_tokens ?? 0, 0),
    cacheWriteTokens,
  )
  const tokenCost =
    (usage.input_tokens / 1_000_000) * modelCosts.inputTokens +
    (usage.output_tokens / 1_000_000) * modelCosts.outputTokens +
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheReadTokens +
    ((cacheWriteTokens - cacheWrite1hTokens) / 1_000_000) *
      modelCosts.promptCacheWriteTokens +
    (cacheWrite1hTokens / 1_000_000) * modelCosts.inputTokens * 2
  // US-only inference is billed at 1.1x token prices.
  const geoMultiplier = usage.inference_geo === 'us' ? 1.1 : 1
  return (
    tokenCost * geoMultiplier +
    (usage.server_tool_use?.web_search_requests ?? 0) *
      modelCosts.webSearchRequests
  )
}

export function getModelCosts(model: string, usage: Usage): ModelCosts {
  const shortName = getCanonicalName(normalizeModelStringForAPI(model))

  if (usage.speed === 'fast') {
    if (
      shortName === firstPartyNameToCanonical(CLAUDE_OPUS_5_5_CONFIG.firstParty)
    ) {
      return COST_TIER_FAST_8_40
    }
    if (shortName === 'claude-opus-5' || shortName === 'claude-opus-4-8') {
      return COST_TIER_FAST_10_50
    }
    if (
      shortName === firstPartyNameToCanonical(CLAUDE_OPUS_4_6_CONFIG.firstParty) ||
      shortName === firstPartyNameToCanonical(CLAUDE_OPUS_4_7_CONFIG.firstParty)
    ) {
      return COST_TIER_FAST_30_150
    }
  }

  const costs = MODEL_COSTS[shortName]
  if (!costs) {
    trackUnknownModelCost(model, shortName)
    return (
      MODEL_COSTS[getCanonicalName(getDefaultMainLoopModelSetting())] ??
      DEFAULT_UNKNOWN_MODEL_COST
    )
  }
  return costs
}

function trackUnknownModelCost(model: string, shortName: ModelShortName): void {
  logEvent('tengu_unknown_model_cost', {
    model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    shortName:
      shortName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  setHasUnknownModelCost()
}

// Calculate the cost of a query in US dollars.
// If the model's costs are not found, use the default model's costs.
export function calculateUSDCost(resolvedModel: string, usage: Usage): number {
  // Boundary guard: a usage object can be missing when a request fails without
  // a normal response body (e.g. the non-streaming fallback recovering from an
  // overload). Treat missing usage as zero cost rather than crashing the query.
  if (!usage) {
    return 0
  }
  const modelCosts = getModelCosts(resolvedModel, usage)
  return tokensToUSDCost(modelCosts, usage)
}

/**
 * Calculate cost from raw token counts without requiring a full BetaUsage object.
 * Useful for side queries (e.g. classifier) that track token counts independently.
 */
export function calculateCostFromTokens(
  model: string,
  tokens: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
  },
): number {
  const usage: Usage = {
    input_tokens: tokens.inputTokens,
    output_tokens: tokens.outputTokens,
    cache_read_input_tokens: tokens.cacheReadInputTokens,
    cache_creation_input_tokens: tokens.cacheCreationInputTokens,
  } as Usage
  return calculateUSDCost(model, usage)
}

function formatPrice(price: number): string {
  // Format price: integers without decimals, others with 2 decimal places
  // e.g., 3 -> "$3", 0.8 -> "$0.80", 22.5 -> "$22.50"
  if (Number.isInteger(price)) {
    return `$${price}`
  }
  return `$${price.toFixed(2)}`
}

/**
 * Format model costs as a pricing string for display
 * e.g., "$3/$15 per Mtok"
 */
export function formatModelPricing(costs: ModelCosts): string {
  const base = `${formatPrice(costs.inputTokens)}/${formatPrice(costs.outputTokens)} per Mtok`
  const long = costs.longPrompt
  return long
    ? `${base} (${formatPrice(long.inputTokens)}/${formatPrice(long.outputTokens)} for prompts over ${formatTokens(long.abovePromptTokens)})`
    : base
}

/**
 * Get formatted pricing string for a model
 * Accepts either a short name or full model name
 * Returns undefined if model is not found
 */
export function getModelPricingString(model: string): string | undefined {
  const shortName = getCanonicalName(normalizeModelStringForAPI(model))
  const costs = MODEL_COSTS[shortName]
  if (!costs) return undefined
  return formatModelPricing(costs)
}
