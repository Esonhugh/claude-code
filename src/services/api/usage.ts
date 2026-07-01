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

export async function fetchUtilization(): Promise<Utilization | null> {
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI)) {
    const chatGPTUtilization = await fetchChatGPTUtilization()
    if (chatGPTUtilization) return chatGPTUtilization
  }

  return fetchClaudeCodeUtilization()
}

export async function consumeRateLimitResetCredit(): Promise<void> {
  if (!isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI)) return
  await consumeChatGPTRateLimitResetCredit()
}
