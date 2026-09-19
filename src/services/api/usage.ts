import { getOpenAIAuthInfo } from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import {
  consumeChatGPTRateLimitResetCredit,
  fetchChatGPTRateLimitResetCredits,
  fetchChatGPTUtilization,
  fetchChatGPTActivity,
} from './usage-chatgpt.js'
import { fetchClaudeCodeUtilization } from './usage-claude.js'
import type {
  RateLimitResetCreditsDetails,
  RateLimitResetResult,
  Utilization,
} from './usage-types.js'

export type {
  ChatGPTMonthlyCreditLimit,
  ChatGPTUsageCredits,
  ExtraUsage,
  OpenAIAccount,
  RateLimit,
  RateLimitResetCredit,
  RateLimitResetCreditsDetails,
  RateLimitResetResult,
  UsageLimit,
  Utilization,
} from './usage-types.js'

export function isOpenAIActivityAvailable(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI) &&
    getOpenAIAuthInfo()?.isChatGPT === true
}

export async function fetchOpenAIActivity() {
  return isOpenAIActivityAvailable() ? fetchChatGPTActivity() : null
}

export function prefetchChatGPTUtilization(): Promise<unknown> | null {
  if (
    !isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI) ||
    !getOpenAIAuthInfo()?.isChatGPT
  ) {
    return null
  }
  return fetchChatGPTUtilization()
}

export async function fetchUtilization(): Promise<Utilization | null> {
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI)) {
    return getOpenAIAuthInfo()?.isChatGPT
      ? fetchChatGPTUtilization()
      : null
  }

  return fetchClaudeCodeUtilization()
}

export async function fetchRateLimitResetCredits(): Promise<RateLimitResetCreditsDetails | null> {
  if (
    !isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI) ||
    !getOpenAIAuthInfo()?.isChatGPT
  ) {
    return null
  }
  return fetchChatGPTRateLimitResetCredits()
}

export async function consumeRateLimitResetCredit(): Promise<RateLimitResetResult | null> {
  if (
    !isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI) ||
    !getOpenAIAuthInfo()?.isChatGPT
  ) {
    return null
  }
  return consumeChatGPTRateLimitResetCredit()
}
