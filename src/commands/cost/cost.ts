import { formatTotalCost } from '../../cost-tracker.js'
import { currentLimits } from '../../services/claudeAiLimits.js'
import type { LocalCommandCall } from '../../types/command.js'
import {
  getOauthAccountInfo,
  getSubscriptionType,
  hasProfileScope,
  isClaudeAISubscriber,
} from '../../utils/auth.js'
import { isAnt } from 'src/utils/userType.js'


export const call: LocalCommandCall = async () => {
  // Like official: only a sign-in that knows its plan, on plan (not
  // usage-based) billing, gets the subscription notice instead of the totals.
  if (
    isClaudeAISubscriber() &&
    (getSubscriptionType() !== null || hasProfileScope()) &&
    getOauthAccountInfo()?.billingType !== 'usage_based'
  ) {
    let value: string

    if (currentLimits.isUsingOverage) {
      value =
        'You are currently using your overages to power your Claude Code usage. We will automatically switch you back to your subscription rate limits when they reset'
    } else {
      value =
        'You are currently using your subscription to power your Claude Code usage'
    }

    if (isAnt()) {
      value += `\n\n[ANT-ONLY] Showing cost anyway:\n ${formatTotalCost()}`
    }
    return { type: 'text', value }
  }
  return { type: 'text', value: formatTotalCost() }
}
