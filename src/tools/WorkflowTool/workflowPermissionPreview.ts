export type WorkflowPermissionPreviewPhase = {
  title: string
  detail?: string
  prompts?: string[]
}

export type WorkflowPermissionPreviewInput = {
  workflowName: string
  description: string
  args?: unknown
  cwd: string
  phases: WorkflowPermissionPreviewPhase[]
}

function truncatePrompt(value: string): string {
  return value.length > 72 ? `${value.slice(0, 71)}…` : value
}

function formatArgs(args: unknown): string | undefined {
  if (args === undefined) return undefined
  return typeof args === 'string' ? JSON.stringify(args) : JSON.stringify(args)
}

export function formatWorkflowPermissionPreview(input: WorkflowPermissionPreviewInput): string {
  const lines = [
    'Run a dynamic workflow?',
    '',
    input.description,
    '',
    'This dynamic workflow will spin up multiple subagents across the following phases:',
  ]

  input.phases.forEach((phase, index) => {
    lines.push(`  ${index + 1}. ${phase.title}${phase.detail ? ` — ${phase.detail}` : ''}`)
    for (const prompt of phase.prompts ?? []) {
      lines.push(`     · "${truncatePrompt(prompt)}"`)
    }
  })

  const args = formatArgs(input.args)
  if (args) {
    lines.push('', `args: ${args}`)
  }

  lines.push(
    '',
    'Dynamic workflows can use a lot of tokens quickly by running many subagents',
    'in parallel — which counts against your usage limit. Stop a running workflow',
    'at any time with /workflows, or disable dynamic workflows in /config.',
    '',
    '1. Yes, run it',
    `2. Yes, and don't ask again for ${input.workflowName} in ${input.cwd}`,
    '3. View raw script',
    '4. No',
    '',
    'Esc to cancel · Tab to amend',
    'ctrl+g to edit script in $EDITOR',
  )

  return lines.join('\n')
}
