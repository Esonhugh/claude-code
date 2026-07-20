import { getOpenAIAuthInfo } from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import {
  consumeChatGPTRateLimitResetCredit,
  fetchChatGPTUtilization,
} from './usage-chatgpt.js'
import { fetchClaudeCodeUtilization } from './usage-claude.js'
import type { Utilization } from './usage-types.js'

export type {
  ChatGPTMonthlyCreditLimit,
  ChatGPTUsageCredits,
  ExtraUsage,
  OpenAIAccount,
  RateLimit,
  UsageLimit,
  Utilization,
} from './usage-types.js'

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

export async function consumeRateLimitResetCredit(): Promise<void> {
  if (
    !isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI) ||
    !getOpenAIAuthInfo()?.isChatGPT
  ) {
    return
  }
  await consumeChatGPTRateLimitResetCredit()
}
