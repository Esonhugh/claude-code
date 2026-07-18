import { randomUUID } from 'crypto'
import axios from 'axios'
import {
  formatOpenAIPlanName,
  getOpenAIAuthInfo,
} from '../../utils/auth.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'
import { checkAndRefreshOpenAITokenIfNeeded } from '../openai-oauth/refresh.js'
import type {
  ChatGPTMonthlyCreditLimit,
  ChatGPTUsageCredits,
  RateLimit,
  UsageLimit,
  Utilization,
} from './usage-types.js'

type ChatGPTRateLimitWindow = {
  used_percent?: number | null
  limit_window_seconds?: number | null
  reset_at?: number | null
}

type ChatGPTRateLimitDetails = {
  primary_window?: ChatGPTRateLimitWindow | null
  secondary_window?: ChatGPTRateLimitWindow | null
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
  rate_limit_reset_credits?: { available_count?: number | null } | null
  spend_control?: {
    individual_limit?: ChatGPTSpendControlLimit | null
  } | null
  additional_rate_limits?: Array<{
    limit_name?: string | null
    metered_feature?: string | null
    rate_limit?: ChatGPTRateLimitDetails | null
  }> | null
}

function getChatGPTRequestHeaders(): Record<string, string> | null {
  const auth = getOpenAIAuthInfo()
  if (!auth?.isChatGPT) return null

  return {
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': getClaudeCodeUserAgent(),
    Referer: 'https://chatgpt.com/',
    Origin: 'https://chatgpt.com',
    ...(auth.accountId ? { 'chatgpt-account-id': auth.accountId } : {}),
  }
}

export async function fetchChatGPTUtilization(): Promise<Utilization | null> {
  await checkAndRefreshOpenAITokenIfNeeded()
  const headers = getChatGPTRequestHeaders()
  if (!headers) return null

  const response = await axios.get<ChatGPTUsageResponse>(
    'https://chatgpt.com/backend-api/wham/usage',
    {
      headers,
      timeout: 5000,
    },
  )

  return mapChatGPTUsageToUtilization(response.data)
}

export async function consumeChatGPTRateLimitResetCredit(): Promise<void> {
  const headers = getChatGPTRequestHeaders()
  if (!headers) return

  await axios.post(
    'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume',
    { redeem_request_id: randomUUID() },
    {
      headers,
      timeout: 5000,
    },
  )
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
    rate_limit_reset_credits:
      typeof data.rate_limit_reset_credits?.available_count === 'number'
        ? { available_count: data.rate_limit_reset_credits.available_count }
        : null,
    openai_account: getChatGPTAccountDisplay(),
    chatgpt_limits: buildChatGPTLimits(
      data,
      primaryWindow,
      secondaryWindow,
      monthlyCreditLimit,
    ),
    monthly_credit_limit: monthlyCreditLimit,
  }
}

function getChatGPTAccountDisplay(): Utilization['openai_account'] {
  const auth = getOpenAIAuthInfo()
  if (!auth?.accountName && !auth?.email) return null
  return {
    name: auth.accountName ?? null,
    email: auth.email ?? null,
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
  const planName = formatOpenAIPlanName(data.plan_type)
  const planSuffix = planName ? ` (${planName})` : ''
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
