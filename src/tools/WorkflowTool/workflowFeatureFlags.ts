type WorkflowSettings = {
  enableWorkflows?: boolean
  disableWorkflows?: boolean
  workflowKeywordTriggerEnabled?: boolean
  ultracodeKeywordTrigger?: boolean
  skipWorkflowUsageWarning?: boolean
}

export function isWorkflowScriptsFeatureEnabled(): boolean {
  return (process.env.CLAUDE_CODE_RECOVER_FEATURES ?? '')
    .split(',')
    .map(value => value.trim())
    .includes('WORKFLOW_SCRIPTS')
}

export function shouldEnableWorkflows(settings: WorkflowSettings | undefined): boolean {
  if (settings?.disableWorkflows) return false
  if (settings?.enableWorkflows === false) return false
  return true
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

export function shouldShowWorkflowUsageWarning(settings: WorkflowSettings | undefined): boolean {
  return settings?.skipWorkflowUsageWarning !== true
}
