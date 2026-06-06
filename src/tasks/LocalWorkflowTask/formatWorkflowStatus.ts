import type { LocalWorkflowTaskState } from './LocalWorkflowTask.js'

function elapsedMs(task: LocalWorkflowTaskState): number {
  return Math.max(0, (task.endTime ?? Date.now()) - task.startTime)
}

function completedAgents(task: LocalWorkflowTaskState): number {
  return task.phases.reduce(
    (sum, phase) => sum + phase.completedAgentIds.length,
    0,
  )
}

function retryCount(task: LocalWorkflowTaskState): number {
  return task.phases.reduce(
    (sum, phase) => sum + phase.failedAgentIds.length,
    0,
  )
}

function progressBar(completed: number, total: number): string {
  const safeTotal = Math.max(total, 0)
  const ratio = safeTotal === 0 ? 0 : completed / safeTotal
  const filled = Math.round(Math.min(1, Math.max(0, ratio)) * 10)
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`
}

function progressPercent(completed: number, total: number): number {
  return total <= 0 ? 0 : Math.round((completed / total) * 100)
}

function formatWorkflowArgs(args: LocalWorkflowTaskState['runArgs']): string {
  if (args === undefined) return '(none)'
  if (typeof args === 'string') return args.trim() || '(none)'
  return JSON.stringify(args)
}

export function formatWorkflowStatus(
  task: LocalWorkflowTaskState,
  options: { detail?: boolean } = {},
): string {
  const completed = completedAgents(task)
  const total = task.agentCount ?? 0
  const lines = [
    `Workflow: ${task.workflowName ?? task.description}`,
    `Task ID: ${task.id}`,
    ...(task.workflowRunId ? [`Workflow run ID: ${task.workflowRunId}`] : []),
    ...(task.scriptPath ? [`Script path: ${task.scriptPath}`] : []),
    `Status: ${task.status}`,
    `Execution: ${task.execution ?? 'agent'}`,
  ]

  if (task.teamName) {
    lines.push(`Team: ${task.teamName}`, 'tmux-backed agents: named team workers')
  }

  if (task.runtime) {
    lines.push(
      `Runtime: ${task.runtime.kind}`,
      `Isolated runtime: ${task.runtime.isolated ? 'yes' : 'no'}`,
    )
    if (task.runtime.sourcePath) {
      lines.push(`Runtime source: ${task.runtime.sourcePath}`)
    }
  }

  lines.push(
    `User input: ${formatWorkflowArgs(task.runArgs)}`,
    `Progress version: ${task.progressVersion ?? 0}`,
    ...(task.defaultModel ? [`Default model: ${task.defaultModel}`] : []),
    `Agents: ${completed}/${total}`,
    `Progress: [${progressBar(completed, total)}] ${completed}/${total} (${progressPercent(completed, total)}%)`,
    `Retries: ${retryCount(task)}`,
    `Official events: ${task.events?.length ?? 0}`,
    `Tokens: ${task.tokenCount ?? 0}`,
    `Tool uses: ${task.toolUseCount ?? 0}`,
    `Elapsed ms: ${elapsedMs(task)}`,
    'Phases:',
  )

  for (const phase of task.phases) {
    const phaseCompleted = phase.completedAgentIds.length
    const phaseTotal = phase.agentIds.length
    lines.push(
      `- ${phase.id}: ${phase.status} ${phaseCompleted}/${phaseTotal} [${progressBar(phaseCompleted, phaseTotal)}] skipped ${phase.skippedAgentIds.length}/${phaseTotal} retries: ${phase.failedAgentIds.length}`,
    )
  }

  if (task.error) {
    lines.push(`Error: ${task.error}`)
  }

  if (options.detail) {
    lines.push('', 'Workflow detail', 'Events:')
    for (const event of (task.events ?? []).slice(-20)) {
      lines.push(`  - ${event.type}: ${JSON.stringify(event)}`)
    }
    lines.push('Controls:')
    lines.push(`  /workflows pause ${task.id}`)
    lines.push(`  /workflows resume ${task.id}`)
    lines.push(`  /workflows retry-agent ${task.id} <phase-id> <agent-id>`)
    lines.push(`  /workflows skip-agent ${task.id} <phase-id> <agent-id>`)
  }

  return lines.join('\n')
}
