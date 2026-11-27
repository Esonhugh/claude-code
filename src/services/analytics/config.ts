/**
 * Shared analytics configuration
 *
 * Common logic for determining when analytics should be disabled
 * across all analytics systems (Datadog, 1P)
 */

import { isEnvTruthy } from '../../utils/envUtils.js'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from '../../utils/model/providers.js'
import { isTelemetryDisabled } from '../../utils/privacyLevel.js'

export function isAnthropicTelemetryEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_ANTHROPIC_TELEMETRY)
}

/**
 * Check if analytics operations should be disabled
 *
 * Analytics is disabled in the following cases:
 * - Test environment (NODE_ENV === 'test')
 * - Any provider other than first-party Anthropic (Bedrock/Vertex/Foundry/OpenAI)
 * - ANTHROPIC_BASE_URL points at a gateway (its credential is not Anthropic's)
 * - Privacy level is no-telemetry or essential-traffic
 */
export function isAnalyticsDisabled(): boolean {
  return (
    process.env.NODE_ENV === 'test' ||
    !isAnthropicTelemetryEnabled() ||
    getAPIProvider() !== 'firstParty' ||
    !isFirstPartyAnthropicBaseUrl() ||
    isTelemetryDisabled()
  )
}

/**
 * Check if the feedback surveys (and the transcript share they offer) should
 * be suppressed. Like analytics, they follow this fork's opt-in, and a gateway
 * base URL keeps its credential away from api.anthropic.com.
 *
 * Unlike isAnalyticsDisabled(), this does NOT block on 3P providers
 * (Bedrock/Vertex/Foundry) — enterprise customers capture responses via OTEL.
 */
export function isFeedbackSurveyDisabled(): boolean {
  return (
    process.env.NODE_ENV === 'test' ||
    !isAnthropicTelemetryEnabled() ||
    !isFirstPartyAnthropicBaseUrl() ||
    isTelemetryDisabled()
  )
}
