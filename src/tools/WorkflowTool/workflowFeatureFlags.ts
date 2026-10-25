import { getSubscriptionType } from '../../utils/auth.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'

export const WORKFLOW_SIZE_GUIDELINES = ['unrestricted', 'small', 'medium', 'large'] as const
export type WorkflowSizeGuideline = (typeof WORKFLOW_SIZE_GUIDELINES)[number]
export const WORKFLOW_SIZE_AGENT_LIMITS = { small: 5, medium: 10, large: 50 }

type WorkflowSettings = {
  enableWorkflows?: boolean
  disableWorkflows?: boolean
  workflowSizeGuideline?: WorkflowSizeGuideline
  workflowKeywordTriggerEnabled?: boolean
  ultracodeKeywordTrigger?: boolean
}

type SubscriptionType = ReturnType<typeof getSubscriptionType>

export function isWorkflowScriptsFeatureEnabled(): boolean {
  return (process.env.CLAUDE_CODE_RECOVER_FEATURES ?? '')
    .split(',')
    .map(value => value.trim())
    .includes('WORKFLOW_SCRIPTS')
}

// Like official 2.1.292: CLAUDE_CODE_WORKFLOWS=1 makes workflows default on regardless of plan.
export function workflowsDefaultOn(subscriptionType: SubscriptionType = getSubscriptionType()): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_WORKFLOWS) || subscriptionType !== 'pro'
}

// Like official 2.1.292: on by default except on the Pro plan; disableWorkflows,
// CLAUDE_CODE_DISABLE_WORKFLOWS, CLAUDE_CODE_WORKFLOWS=0 or enableWorkflows: false turn it off.
export function shouldEnableWorkflows(
  settings: WorkflowSettings | undefined,
  subscriptionType?: SubscriptionType,
): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_WORKFLOWS) || isEnvDefinedFalsy(process.env.CLAUDE_CODE_WORKFLOWS)) {
    return false
  }
  if (settings?.disableWorkflows === true) return false
  return settings?.enableWorkflows ?? workflowsDefaultOn(subscriptionType)
}

export function defaultWorkflowSizeGuideline(
  subscriptionType: SubscriptionType = getSubscriptionType(),
): WorkflowSizeGuideline {
  return subscriptionType === 'pro' ? 'small' : 'medium'
}

// Like official, the Workflow tool prompt ends with the advisory size guideline: a settings
// value wins over the /config choice, and "unrestricted" sends none.
export function workflowSizeGuidelinePrompt(
  settings: WorkflowSettings | undefined,
  configured: WorkflowSizeGuideline | undefined,
  subscriptionType?: SubscriptionType,
): string {
  const chosen = settings?.workflowSizeGuideline ?? configured
  const size = chosen ?? defaultWorkflowSizeGuideline(subscriptionType)
  if (size === 'unrestricted') return ''
  const limit = `${size} — keep workflows under ${WORKFLOW_SIZE_AGENT_LIMITS[size]} agents`
  const note = "This is a guideline, not a hard limit — follow it unless the user's prompt calls for a different scale."
  return chosen === undefined
    ? `\n\nThis session has the default workflow size guideline: ${limit}. ${note} The user can raise or remove it with "Dynamic workflow size" in /config.`
    : `\n\nA workflow size guideline is configured for this session: ${limit}. ${note}`
}

export function isWorkflowKeywordTriggerEnabled(settings: WorkflowSettings | undefined): boolean {
  if (settings?.workflowKeywordTriggerEnabled !== undefined) {
    return settings.workflowKeywordTriggerEnabled
  }
  if (settings?.ultracodeKeywordTrigger !== undefined) {
    return settings.ultracodeKeywordTrigger
  }
  return true
}
