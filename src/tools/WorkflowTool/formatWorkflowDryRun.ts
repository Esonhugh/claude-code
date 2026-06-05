import type { WorkflowDryRunPhase, WorkflowDryRunPlan } from './workflowSpec.js'

function formatPhase(phase: WorkflowDryRunPhase): string {
  const fields = [
    `- ${phase.id}`,
    `depends: ${phase.dependsOn.length > 0 ? phase.dependsOn.join(', ') : 'none'}`,
    `fanout: ${phase.fanout}`,
    `concurrency: ${phase.concurrency}`,
    `review: ${phase.review}`,
    `permissionMode: ${phase.permissionMode}`,
  ]

  if (phase.agentType) {
    fields.push(`agentType: ${phase.agentType}`)
  }

  if (phase.model) {
    fields.push(`model: ${phase.model}`)
  }

  return fields.join(' | ')
}

export function formatWorkflowDryRun(plan: WorkflowDryRunPlan): string {
  const lines = [
    `Workflow: ${plan.name}`,
    `Description: ${plan.description}`,
    `Max concurrency: ${plan.defaults.maxConcurrency}`,
    `Max agents: ${plan.defaults.maxAgents}`,
    `Max retries: ${plan.defaults.maxRetries}`,
    `Execution: ${plan.defaults.execution}`,
  ]

  if (plan.runtime) {
    lines.push(
      `Runtime: ${plan.runtime.kind}`,
      `Isolated runtime: ${plan.runtime.isolated ? 'yes' : 'no'}`,
    )
    if (plan.runtime.sourcePath) {
      lines.push(`Runtime source: ${plan.runtime.sourcePath}`)
    }
  }

  lines.push(
    `Planned agents: ${plan.totalAgents}`,
    'Phases:',
    ...plan.phases.map(formatPhase),
  )

  return `${lines.join('\n')}\n`
}
