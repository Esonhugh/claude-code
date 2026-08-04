export const workflowDialogDismissedMessage = 'Dynamic workflows dialog dismissed'

export function shouldOpenWorkflowsPageForArgs(args?: string): boolean {
  return !args?.trim()
}
