import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import {
  getClaudeAIOAuthTokens,
  hasProfileScope,
  isClaudeAISubscriber,
} from '../../utils/auth.js'
import { getAuthHeaders } from '../../utils/http.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { isOAuthTokenExpired } from '../oauth/client.js'
import type { UsageLimit, Utilization } from './usage-types.js'

// Models whose weekly window is billed as overage-included (the Fable
// family). Official reads the list from GrowthBook; this build falls back to
// the same names when the flag is absent so the row never silently disappears.
const DEFAULT_OVERAGE_INCLUDED_MODELS = ['Fable', 'Fable 5', 'Fable 5.1']

export function getOverageIncludedModelAllowlist(): string[] {
  const value = getFeatureValue_CACHED_MAY_BE_STALE<unknown>(
    'tengu_usage_overage_included_models',
    null,
  )
  if (!Array.isArray(value)) return DEFAULT_OVERAGE_INCLUDED_MODELS
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * Project the per-model weekly rows of the usage endpoint's `limits[]` into
 * usage bars, keeping only allowlisted models (surface-scoped rows are not
 * shown in the CLI).
 */
export function getModelScopedUsageLimits(
  limits: Utilization['limits'],
  allowlist: string[] = getOverageIncludedModelAllowlist(),
): UsageLimit[] {
  if (!Array.isArray(limits) || allowlist.length === 0) return []
  const names = allowlist.map(name => name.toLowerCase())
  return limits.flatMap(row => {
    const displayName =
      row?.kind === 'weekly_scoped' ? row.scope?.model?.display_name : undefined
    if (
      typeof displayName !== 'string' ||
      typeof row.percent !== 'number' ||
      !names.includes(displayName.toLowerCase())
    ) {
      return []
    }
    return [
      {
        title: `Current week (${displayName})`,
        limit: { utilization: row.percent, resets_at: row.resets_at ?? null },
      },
    ]
  })
}

export async function fetchClaudeCodeUtilization(): Promise<Utilization | null> {
  if (!isClaudeAISubscriber() || !hasProfileScope()) {
    return {}
  }

  // Skip API call if OAuth token is expired to avoid 401 errors
  const tokens = getClaudeAIOAuthTokens()
  if (tokens && isOAuthTokenExpired(tokens.expiresAt)) {
    return null
  }

  const authResult = getAuthHeaders()
  if (authResult.error) {
    throw new Error(`Auth error: ${authResult.error}`)
  }

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': getClaudeCodeUserAgent(),
    ...authResult.headers,
  }

  const url = `${getOauthConfig().BASE_API_URL}/api/oauth/usage`

  const response = await axios.get<Utilization>(url, {
    headers,
    timeout: 5000, // 5 second timeout
  })

  return response.data
}
