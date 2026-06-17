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
}

export type ExtraUsage = {
  is_enabled: boolean
  monthly_limit: number | null
  used_credits: number | null
  utilization: number | null
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
}

type ChatGPTUsageWindow = {
  used_percent?: number | null
  reset_at?: number | null
}

type ChatGPTUsageCredits = {
  has_credits?: boolean
  unlimited?: boolean
  balance?: number | null
  overage_limit_reached?: boolean
}

type ChatGPTUsageResponse = {
  plan_type?: string | null
  rate_limit?: {
    primary_window?: ChatGPTUsageWindow | null
    secondary_window?: ChatGPTUsageWindow | null
  } | null
  credits?: ChatGPTUsageCredits | null
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
  return {
    source: 'chatgpt',
    plan_type: data.plan_type ?? null,
    five_hour: null,
    seven_day: mapChatGPTWindow(data.rate_limit?.primary_window),
    seven_day_sonnet: mapChatGPTWindow(data.rate_limit?.secondary_window),
    credits: data.credits ?? null,
  }
}

function mapChatGPTWindow(
  window: ChatGPTUsageWindow | null | undefined,
): RateLimit | null {
  if (!window || window.used_percent === undefined || window.used_percent === null) {
    return null
  }

  return {
    utilization: window.used_percent,
    resets_at: window.reset_at
      ? new Date(window.reset_at * 1000).toISOString()
      : null,
  }
}
