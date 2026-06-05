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

export function formatWorkflowStatus(task: LocalWorkflowTaskState): string {
  const completed = completedAgents(task)
  const total = task.agentCount ?? 0
  const lines = [
    `Workflow: ${task.workflowName ?? task.description}`,
    `Task ID: ${task.id}`,
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
    `User input: ${task.runArgs?.trim() || '(none)'}`,
    `Agents: ${completed}/${total}`,
    `Progress: [${progressBar(completed, total)}] ${completed}/${total} (${progressPercent(completed, total)}%)`,
    `Retries: ${retryCount(task)}`,
    `Tokens: ${task.tokenCount ?? 0}`,
    `Tool uses: ${task.toolUseCount ?? 0}`,
    `Elapsed ms: ${elapsedMs(task)}`,
    'Phases:',
  )

  for (const phase of task.phases) {
    const phaseCompleted = phase.completedAgentIds.length
    const phaseTotal = phase.agentIds.length
    lines.push(
      `- ${phase.id}: ${phase.status} ${phaseCompleted}/${phaseTotal} [${progressBar(phaseCompleted, phaseTotal)}] retries: ${phase.failedAgentIds.length}`,
    )
  }

  if (task.error) {
    lines.push(`Error: ${task.error}`)
  }

  return lines.join('\n')
}
