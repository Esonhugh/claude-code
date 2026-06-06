import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { WorkflowProgressEvent } from '../../tools/WorkflowTool/workflowSpec.js'

const PANEL_WIDTH = 110
const LEFT_WIDTH = 16
const RIGHT_WIDTH = PANEL_WIDTH - LEFT_WIDTH - 3

function completedAgents(task: LocalWorkflowTaskState): number {
  return task.phases.reduce((sum, phase) => sum + phase.completedAgentIds.length, 0)
}

function elapsedMs(task: LocalWorkflowTaskState): number {
  return Math.max(0, (task.endTime ?? Date.now()) - task.startTime)
}

function eventSummary(event: WorkflowProgressEvent): string {
  if (event.type === 'workflow_progress') {
    return `${event.type} ${event.status} ${event.completedAgents}/${event.totalAgents}`
  }
  if (event.type === 'workflow_phase') {
    return `${event.type} ${event.phaseId} ${event.status}`
  }
  if (event.type === 'workflow_agent') {
    return `${event.type} ${event.agentId} ${event.status}${event.cacheHit ? ' cache hit' : ''}`
  }
  return `${event.type} ${event.message}`
}

function workflowTitle(task: LocalWorkflowTaskState): string {
  return task.workflowName ?? task.description.replace(/^Workflow:\s*/i, '')
}

function workflowDescription(task: LocalWorkflowTaskState): string {
  return task.summary ?? task.description.replace(/^Workflow:\s*/i, '')
}

function pad(value: string, width: number): string {
  const truncated = value.length > width ? value.slice(0, Math.max(0, width - 1)) : value
  return `${truncated}${' '.repeat(Math.max(0, width - truncated.length))}`
}

function phaseLabel(
  task: LocalWorkflowTaskState,
  phaseIndex: number,
  selected: boolean,
): string {
  const phase = task.phases[phaseIndex]
  if (!phase) return ''.padEnd(LEFT_WIDTH)
  const marker = selected ? '❯ ' : '  '
  return pad(
    `${marker}${phaseIndex + 1} ${phase.id}   ${phase.completedAgentIds.length}/${phase.agentIds.length}`,
    LEFT_WIDTH,
  )
}

function phaseHeader(task: LocalWorkflowTaskState): string {
  const selectedPhase = task.phases[0]
  if (!selectedPhase) return ''.padEnd(RIGHT_WIDTH)
  return pad(`${selectedPhase.id} · ${selectedPhase.agentIds.length} ${selectedPhase.agentIds.length === 1 ? 'agent' : 'agents'} `, RIGHT_WIDTH)
}

function agentRow(task: LocalWorkflowTaskState, agentId: string, selected: boolean): string {
  const result = task.results.find(item => item.agentId === agentId) ?? task.phases.flatMap(phase => phase.results).find(item => item.agentId === agentId)
  const model = task.defaultModel ?? 'gpt-5.5[1m]'
  const tokens = result?.tokenCount ?? 0
  const toolUses = result?.toolUseCount ?? 0
  const marker = selected ? '❯' : ' '
  return pad(
    `${marker}⏺ ${agentId.padEnd(24)} ${model.padEnd(14)} ${tokens} tok · ${toolUses} ${toolUses === 1 ? 'tool' : 'tools'}`,
    RIGHT_WIDTH,
  )
}

function formatHeader(task: LocalWorkflowTaskState): string[] {
  const completed = completedAgents(task)
  const total = task.agentCount ?? 0
  const description = workflowDescription(task)
  const metrics = `${completed}/${total} ${total === 1 ? 'agent' : 'agents'} · ${elapsedMs(task)}ms`
  return [
    workflowTitle(task),
    `${pad(description, Math.max(1, PANEL_WIDTH - metrics.length - 1))} ${metrics}`,
  ]
}

function formatPhasePanel(task: LocalWorkflowTaskState): string[] {
  const selectedPhase = task.phases[0]
  const top = `╭ ${pad('Phases', LEFT_WIDTH - 2).replace(/\s+$/g, ' ────────')}┬ ${phaseHeader(task).replace(/\s+$/g, ' ─────────────────────────────────────────────────────────────────────────────')}╮`
  const rows: string[] = [top]
  const maxRows = Math.max(task.phases.length, selectedPhase?.agentIds.length ?? 0, 1)
  for (let index = 0; index < maxRows; index += 1) {
    rows.push(
      `│ ${phaseLabel(task, index, index === 0)}│ ${selectedPhase?.agentIds[index] ? agentRow(task, selectedPhase.agentIds[index]!, false) : ''.padEnd(RIGHT_WIDTH)}│`,
    )
  }
  rows.push(`╰${'─'.repeat(LEFT_WIDTH)}┴${'─'.repeat(RIGHT_WIDTH + 1)}╯`)
  return rows
}

function formatControls(task: LocalWorkflowTaskState): string {
  return task.status === 'running'
    ? '↑↓ select · x stop workflow · p pause · esc back · s save'
    : '↑↓ select · esc back · s save'
}

export function formatWorkflowDetailSnapshot(task: LocalWorkflowTaskState): string {
  const lines = [
    ...formatHeader(task),
    '',
    ...formatPhasePanel(task),
    '',
    'Recent events',
  ]

  for (const event of (task.events ?? []).slice(-8)) {
    lines.push(`- ${eventSummary(event)}`)
  }

  lines.push('', formatControls(task))
  return lines.join('\n')
}
