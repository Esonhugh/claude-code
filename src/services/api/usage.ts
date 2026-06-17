import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import {
  getClaudeAIOAuthTokens,
  getOpenAIAuthInfo,
  hasProfileScope,
  isClaudeAISubscriber,
} from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getAuthHeaders } from '../../utils/http.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'
import { isOAuthTokenExpired } from '../oauth/client.js'

export type RateLimit = {
  utilization: number | null // a percentage from 0 to 100
  resets_at: string | null // ISO 8601 timestamp
  window_minutes?: number | null
}

export type ExtraUsage = {
  is_enabled: boolean
  monthly_limit: number | null
  used_credits: number | null
  utilization: number | null
}

export type UsageLimit = {
  title: string
  limit: RateLimit
  extraSubtext?: string
}

export type ChatGPTMonthlyCreditLimit = {
  limit: string
  used: string
  remaining: string | null
  utilization: number | null
  resets_at: string | null
}

export type Utilization = {
  five_hour?: RateLimit | null
  seven_day?: RateLimit | null
  seven_day_oauth_apps?: RateLimit | null
  seven_day_opus?: RateLimit | null
  seven_day_sonnet?: RateLimit | null
  extra_usage?: ExtraUsage | null
  source?: 'claude' | 'chatgpt'
  plan_type?: string | null
  credits?: ChatGPTUsageCredits | null
  chatgpt_limits?: UsageLimit[]
  monthly_credit_limit?: ChatGPTMonthlyCreditLimit | null
}

type ChatGPTRateLimitWindow = {
  used_percent?: number | null
  limit_window_seconds?: number | null
  reset_at?: number | null
}

type ChatGPTRateLimitDetails = {
  primary_window?: ChatGPTRateLimitWindow | null
  secondary_window?: ChatGPTRateLimitWindow | null
}

type ChatGPTUsageCredits = {
  has_credits?: boolean
  unlimited?: boolean
  balance?: number | null
  overage_limit_reached?: boolean
}

type ChatGPTSpendControlLimit = {
  limit?: string | null
  used?: string | null
  remaining?: string | null
  used_percent?: number | null
  reset_at?: number | null
}

type ChatGPTUsageResponse = {
  plan_type?: string | null
  rate_limit?: ChatGPTRateLimitDetails | null
  credits?: ChatGPTUsageCredits | null
  spend_control?: {
    individual_limit?: ChatGPTSpendControlLimit | null
  } | null
  additional_rate_limits?: Array<{
    limit_name?: string | null
    metered_feature?: string | null
    rate_limit?: ChatGPTRateLimitDetails | null
  }> | null
}

export async function fetchUtilization(): Promise<Utilization | null> {
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI)) {
    const chatGPTUtilization = await fetchChatGPTUtilization()
    if (chatGPTUtilization) return chatGPTUtilization
  }

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

async function fetchChatGPTUtilization(): Promise<Utilization | null> {
  const auth = getOpenAIAuthInfo()
  if (!auth?.isChatGPT) return null

  const response = await axios.get<ChatGPTUsageResponse>(
    'https://chatgpt.com/backend-api/wham/usage',
    {
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': getClaudeCodeUserAgent(),
        Referer: 'https://chatgpt.com/',
        Origin: 'https://chatgpt.com',
        ...(auth.accountId ? { 'chatgpt-account-id': auth.accountId } : {}),
      },
      timeout: 5000,
    },
  )

  return mapChatGPTUsageToUtilization(response.data)
}

function mapChatGPTUsageToUtilization(
  data: ChatGPTUsageResponse,
): Utilization {
  const primaryWindow = mapChatGPTWindow(data.rate_limit?.primary_window)
  const secondaryWindow = mapChatGPTWindow(data.rate_limit?.secondary_window)
  const monthlyCreditLimit = mapChatGPTMonthlyCreditLimit(
    data.spend_control?.individual_limit,
  )

  return {
    source: 'chatgpt',
    plan_type: data.plan_type ?? null,
    five_hour: null,
    seven_day: primaryWindow,
    seven_day_sonnet: secondaryWindow,
    credits: data.credits ?? null,
    chatgpt_limits: buildChatGPTLimits(
      data,
      primaryWindow,
      secondaryWindow,
      monthlyCreditLimit,
    ),
    monthly_credit_limit: monthlyCreditLimit,
  }
}

function mapChatGPTWindow(
  window: ChatGPTRateLimitWindow | null | undefined,
): RateLimit | null {
  if (!window || window.used_percent === undefined || window.used_percent === null) {
    return null
  }

  return {
    utilization: window.used_percent,
    resets_at: window.reset_at
      ? new Date(window.reset_at * 1000).toISOString()
      : null,
    window_minutes:
      typeof window.limit_window_seconds === 'number'
        ? Math.round(window.limit_window_seconds / 60)
        : null,
  }
}

function mapChatGPTMonthlyCreditLimit(
  limit: ChatGPTSpendControlLimit | null | undefined,
): ChatGPTMonthlyCreditLimit | null {
  if (!limit || !limit.limit || !limit.used) return null

  return {
    limit: limit.limit,
    used: limit.used,
    remaining: limit.remaining ?? null,
    utilization: limit.used_percent ?? null,
    resets_at: limit.reset_at ? new Date(limit.reset_at * 1000).toISOString() : null,
  }
}

function buildChatGPTLimits(
  data: ChatGPTUsageResponse,
  primaryWindow: RateLimit | null,
  secondaryWindow: RateLimit | null,
  monthlyCreditLimit: ChatGPTMonthlyCreditLimit | null,
): UsageLimit[] {
  const planSuffix = data.plan_type ? ` (${data.plan_type})` : ''
  const limits: UsageLimit[] = []

  if (primaryWindow) {
    limits.push({
      title: `ChatGPT Codex ${formatChatGPTWindowName(primaryWindow)}${planSuffix}`,
      limit: primaryWindow,
    })
  }

  if (secondaryWindow) {
    limits.push({
      title: `Secondary ${formatChatGPTWindowName(secondaryWindow)}`,
      limit: secondaryWindow,
    })
  }

  for (const additionalLimit of data.additional_rate_limits ?? []) {
    const primaryAdditionalWindow = mapChatGPTWindow(
      additionalLimit.rate_limit?.primary_window,
    )
    const secondaryAdditionalWindow = mapChatGPTWindow(
      additionalLimit.rate_limit?.secondary_window,
    )
    const titlePrefix = formatAdditionalRateLimitName(additionalLimit)

    if (primaryAdditionalWindow) {
      limits.push({
        title: `${titlePrefix} ${formatChatGPTWindowName(primaryAdditionalWindow)}`,
        limit: primaryAdditionalWindow,
      })
    }
    if (secondaryAdditionalWindow) {
      limits.push({
        title: `${titlePrefix} secondary ${formatChatGPTWindowName(secondaryAdditionalWindow)}`,
        limit: secondaryAdditionalWindow,
      })
    }
  }

  if (monthlyCreditLimit && monthlyCreditLimit.utilization !== null) {
    limits.push({
      title: 'Monthly credit limit',
      limit: {
        utilization: monthlyCreditLimit.utilization,
        resets_at: monthlyCreditLimit.resets_at,
      },
      extraSubtext: `${monthlyCreditLimit.used} of ${monthlyCreditLimit.limit} credits used`,
    })
  }

  return limits
}

function formatAdditionalRateLimitName(
  additionalLimit: NonNullable<ChatGPTUsageResponse['additional_rate_limits']>[number],
): string {
  return (
    additionalLimit.limit_name ??
    additionalLimit.metered_feature ??
    'Additional usage'
  )
}

function formatChatGPTWindowName(limit: RateLimit): string {
  switch (limit.window_minutes) {
    case 5 * 60:
      return '5h usage'
    case 7 * 24 * 60:
      return 'weekly usage'
    case 30 * 24 * 60:
      return 'monthly usage'
    default:
      return 'usage'
  }
}
