export function isWorkflowScriptsFeatureEnabled(): boolean {
  return (process.env.CLAUDE_CODE_RECOVER_FEATURES ?? '')
    .split(',')
    .map(value => value.trim())
    .includes('WORKFLOW_SCRIPTS')
}
