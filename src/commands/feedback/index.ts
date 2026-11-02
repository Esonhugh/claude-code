import type { Command } from '../../commands.js'
import { isAnalyticsDisabled } from '../../services/analytics/config.js'
import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { isAnt } from 'src/utils/userType.js'


// Official 2.1.311 keeps /feedback visible when one of these switches turns it
// off and answers with the reason instead.
export function feedbackDisabledReason(name = '/feedback'): string | null {
  if (isEnvTruthy(process.env.DISABLE_FEEDBACK_COMMAND))
    return `${name} has been disabled via the DISABLE_FEEDBACK_COMMAND environment variable`
  if (isEnvTruthy(process.env.DISABLE_BUG_COMMAND))
    return `${name} has been disabled via the DISABLE_BUG_COMMAND environment variable`
  if (isEssentialTrafficOnly())
    return `${name} has been disabled via the CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC environment variable`
  return null
}

const feedback = {
  aliases: ['bug'],
  type: 'local-jsx',
  name: 'feedback',
  description: `Submit feedback about Claude Code`,
  argumentHint: '[report]',
  immediate: true,
  // Uploads the transcript to Anthropic, so it follows the analytics opt-in.
  isEnabled: () =>
    feedbackDisabledReason() !== null ||
    !(
      isAnalyticsDisabled() ||
      isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
      isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
      isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY) ||
      isAnt() ||
      !isPolicyAllowed('allow_product_feedback')
    ),
  load: () => import('./feedback.js'),
} satisfies Command

export default feedback
