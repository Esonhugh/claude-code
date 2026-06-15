import type { WorkflowDryRunPhase } from './workflowSpec.js'

export function workflowPhaseExecutionOrder(
  phases: WorkflowDryRunPhase[],
): WorkflowDryRunPhase[] {
  const remaining = new Map(phases.map(phase => [phase.id, phase]))
  const completed = new Set<string>()
  const ordered: WorkflowDryRunPhase[] = []

  while (remaining.size > 0) {
    const ready = phases.filter(
      phase =>
        remaining.has(phase.id) &&
        phase.dependsOn.every(dependencyId => completed.has(dependencyId)),
    )

    if (ready.length === 0) {
      throw new Error('Workflow dependency cycle detected during execution')
    }

    for (const phase of ready) {
      remaining.delete(phase.id)
      completed.add(phase.id)
      ordered.push(phase)
    }
  }

  return ordered
}
