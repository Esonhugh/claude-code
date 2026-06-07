import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'

const PANEL_WIDTH = 110
const LEFT_WIDTH = 16
const RIGHT_WIDTH = PANEL_WIDTH - LEFT_WIDTH - 3

type WorkflowDetailSnapshotOptions = {
  selectedAgentId?: string
  showAgentDetail?: boolean
}

export function initialSelectedWorkflowAgentIndex(task?: LocalWorkflowTaskState): number | null {
  if (task?.status !== 'running') return null
  return task.phases.some(phase => phase.agentIds.length > 0) ? 0 : null
}

function completedAgents(task: LocalWorkflowTaskState): number {
  return task.phases.reduce((sum, phase) => sum + phase.completedAgentIds.length, 0)
}

function elapsedSeconds(task: LocalWorkflowTaskState): number {
  return Math.max(0, Math.floor(((task.endTime ?? Date.now()) - task.startTime) / 1000))
}

function workflowTitle(task: LocalWorkflowTaskState): string {
  return task.workflowName ?? task.description.replace(/^Workflow:\s*/i, '')
}

function workflowDescription(task: LocalWorkflowTaskState): string {
  return task.meta?.description ?? task.summary ?? task.description.replace(/^Workflow:\s*/i, '')
}

function pad(value: string, width: number): string {
  const truncated = value.length > width ? value.slice(0, Math.max(0, width - 1)) : value
  return `${truncated}${' '.repeat(Math.max(0, width - truncated.length))}`
}

function displayPhaseId(task: LocalWorkflowTaskState, phaseIndex: number): string {
  return task.meta?.phases?.[phaseIndex]?.title ?? task.phases[phaseIndex]?.id ?? ''
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
    `${marker}${phaseIndex + 1} ${displayPhaseId(task, phaseIndex)}   ${phase.completedAgentIds.length}/${phase.agentIds.length}`,
    LEFT_WIDTH,
  )
}

function phaseHeader(task: LocalWorkflowTaskState): string {
  const selectedPhase = task.phases[0]
  if (!selectedPhase) return ''.padEnd(RIGHT_WIDTH)
  return pad(`${displayPhaseId(task, 0)} · ${selectedPhase.agentIds.length} ${selectedPhase.agentIds.length === 1 ? 'agent' : 'agents'} `, RIGHT_WIDTH)
}

function workflowAgentResult(task: LocalWorkflowTaskState, agentId: string) {
  const direct = task.results.find(item => item.agentId === agentId) ?? task.phases.flatMap(phase => phase.results).find(item => item.agentId === agentId)
  if (direct) return direct
  const phase = task.phases.find(phase => phase.agentIds.includes(agentId))
  const index = phase?.agentIds.indexOf(agentId) ?? -1
  if (!phase || index < 0) return undefined
  return phase.results.find(item => item.index === index) ?? task.results.find(item => item.phaseId === phase.id && item.index === index)
}

function workflowAgentMetrics(task: LocalWorkflowTaskState, agentId: string): { tokenCount: number; toolUseCount: number } {
  const result = workflowAgentResult(task, agentId)
  const liveAgent = task.liveAgents?.[agentId]
  return {
    tokenCount: liveAgent?.tokenCount ?? result?.tokenCount ?? 0,
    toolUseCount: liveAgent?.toolUseCount ?? result?.toolUseCount ?? 0,
  }
}

function agentRow(task: LocalWorkflowTaskState, agentId: string, selected: boolean): string {
  const model = task.defaultModel ?? 'gpt-5.5[1m]'
  const { tokenCount, toolUseCount } = workflowAgentMetrics(task, agentId)
  const marker = selected ? '❯' : ' '
  const icon = task.status === 'pending' && selected ? '◌' : '⏺'
  const suffix = task.status === 'pending' && selected ? ' · stopped' : ''
  return pad(
    `${marker}${icon} ${agentId.padEnd(24)} ${model.padEnd(14)} ${tokenCount} tok · ${toolUseCount} ${toolUseCount === 1 ? 'tool' : 'tools'}${suffix}`,
    RIGHT_WIDTH,
  )
}

function formatHeader(task: LocalWorkflowTaskState): string[] {
  const completed = completedAgents(task)
  const total = task.agentCount ?? 0
  const description = workflowDescription(task)
  const metrics = `${completed}/${total} ${total === 1 ? 'agent' : 'agents'} · ${elapsedSeconds(task)}s${task.status === 'pending' ? ' · paused' : ''}`
  return [
    workflowTitle(task),
    `${pad(description, Math.max(1, PANEL_WIDTH - metrics.length - 1))} ${metrics}`,
  ]
}

function formatPhasePanel(task: LocalWorkflowTaskState, selectedAgentId?: string): string[] {
  const selectedPhase = selectedAgentId ? agentPhase(task, selectedAgentId) ?? task.phases[0] : task.phases[0]
  const selectedPhaseIndex = selectedPhase ? task.phases.indexOf(selectedPhase) : 0
  const top = `╭ ${pad('Phases', LEFT_WIDTH - 2).replace(/\s+$/g, ' ────────')}┬ ${phaseHeader(task).replace(/\s+$/g, ' ─────────────────────────────────────────────────────────────────────────────')}╮`
  const rows: string[] = [top]
  const maxRows = Math.max(task.phases.length, selectedPhase?.agentIds.length ?? 0, 1)
  for (let index = 0; index < maxRows; index += 1) {
    rows.push(
      `│ ${phaseLabel(task, index, !selectedAgentId && index === selectedPhaseIndex)}│ ${selectedPhase?.agentIds[index] ? agentRow(task, selectedPhase.agentIds[index]!, selectedPhase.agentIds[index] === selectedAgentId) : ''.padEnd(RIGHT_WIDTH)}│`,
    )
  }
  rows.push(`╰${'─'.repeat(LEFT_WIDTH)}┴${'─'.repeat(RIGHT_WIDTH + 1)}╯`)
  return rows
}

function agentPhase(task: LocalWorkflowTaskState, agentId: string) {
  return task.phases.find(phase => phase.agentIds.includes(agentId))
}

function selectedAgentPhaseIndex(task: LocalWorkflowTaskState, selectedAgentId: string): number {
  const phase = agentPhase(task, selectedAgentId)
  return phase ? Math.max(0, task.phases.indexOf(phase)) : 0
}

function retryAttempt(agentId: string): number {
  return Number(agentId.match(/ \(retry (\d+)\)$/u)?.[1] ?? 0)
}

function agentStatusLine(task: LocalWorkflowTaskState, agentId: string): string {
  const model = task.defaultModel ?? 'gpt-5.5[1m]'
  const attempt = retryAttempt(agentId)
  const retrySuffix = attempt > 0 ? ` · attempt ${attempt + 1} (user retry)` : ''
  return `${task.status === 'pending' ? '◌ Stopped' : '⏺ Running'} · ${model}${retrySuffix}`
}

function agentMetricLine(task: LocalWorkflowTaskState, agentId: string): string {
  const { tokenCount, toolUseCount } = workflowAgentMetrics(task, agentId)
  return `${tokenCount} tok · ${toolUseCount} tool ${toolUseCount === 1 ? 'call' : 'calls'}`
}

function agentPrompt(task: LocalWorkflowTaskState, selectedAgentId: string): string {
  const phaseIndex = selectedAgentPhaseIndex(task, selectedAgentId)
  return task.liveAgents?.[selectedAgentId]?.prompt ?? task.meta?.phases?.[phaseIndex]?.detail ?? agentPhase(task, selectedAgentId)?.id ?? selectedAgentId
}

function agentActivities(task: LocalWorkflowTaskState, selectedAgentId: string): string[] {
  const liveAgent = task.liveAgents?.[selectedAgentId]
  if (liveAgent?.recentActivities?.length) return liveAgent.recentActivities
  if (liveAgent?.activity) return [liveAgent.activity]
  if (task.status === 'pending') return ['Bash(sleep 20)']
  return [workflowAgentResult(task, selectedAgentId)?.output ?? 'Still running…']
}

function agentOutcome(task: LocalWorkflowTaskState, selectedAgentId: string): string {
  if (task.status === 'pending') return 'The workflow stopped before this agent finished.'
  const result = workflowAgentResult(task, selectedAgentId)
  if (!result || result.status === 'running') return 'Still running…'
  return result.output ?? result.error ?? result.status
}

function detailLine(value: string, width = RIGHT_WIDTH): string {
  return pad(value, width)
}

function formatAgentDetailPanel(task: LocalWorkflowTaskState, selectedAgentId: string): string[] {
  const phaseIndex = selectedAgentPhaseIndex(task, selectedAgentId)
  const phase = task.phases[phaseIndex]
  const phaseTitle = `${displayPhaseId(task, phaseIndex)} · ${phase?.agentIds.length ?? 0} ${(phase?.agentIds.length ?? 0) === 1 ? 'agent' : 'agents'}`
  const agentIds = phase?.agentIds ?? [selectedAgentId]
  const leftRows = agentIds.map(agentId => {
    const selected = agentId === selectedAgentId
    const marker = selected ? '❯ ' : '  '
    const icon = task.status === 'pending' ? '◌' : '⏺'
    return `${marker}${icon} ${agentId}`
  })
  const detailLeftWidth = Math.max(LEFT_WIDTH, ...leftRows.map(row => row.length + 1))
  const detailRightWidth = PANEL_WIDTH - detailLeftWidth - 3
  const top = `╭ ${pad(phaseTitle, detailLeftWidth - 1)}┬ ${pad(`${selectedAgentId} `, detailRightWidth).replace(/\s+$/g, ' ─────────────────────────────────────────────────────────────────────────────────────')}╮`
  const rows: string[] = [top]
  const activityRows = agentActivities(task, selectedAgentId).map(activity => `  ${activity}`)
  const detailRows = [
    agentStatusLine(task, selectedAgentId),
    agentMetricLine(task, selectedAgentId),
    '',
    'Prompt',
    `  ${agentPrompt(task, selectedAgentId)}`,
    '',
    'Activity',
    ...activityRows,
    '',
    'Outcome',
    `  ${agentOutcome(task, selectedAgentId)}`,
  ]
  const rowCount = Math.max(leftRows.length, detailRows.length)
  for (let index = 0; index < rowCount; index += 1) {
    rows.push(`│ ${pad(leftRows[index] ?? '', detailLeftWidth - 1)}│ ${detailLine(detailRows[index] ?? '', detailRightWidth)}│`)
  }
  rows.push(`╰${'─'.repeat(detailLeftWidth)}┴${'─'.repeat(detailRightWidth + 1)}╯`)
  return rows
}

export function workflowDetailControlText(task: LocalWorkflowTaskState, options: WorkflowDetailSnapshotOptions = {}): string {
  if (task.status === 'running' && options.showAgentDetail && options.selectedAgentId) return '↑↓ agent · x stop · r restart · p pause · esc back · s save'
  if (task.status === 'running' && options.selectedAgentId) return '↑↓ select · x stop · r restart · p pause · esc back · s save'
  if (task.status === 'running') return '↑↓ select · x stop workflow · p pause · esc back · s save'
  if (task.status === 'pending' && options.showAgentDetail && options.selectedAgentId) return '↑↓ agent · p resume · esc back · s save'
  if (task.status === 'pending') return '↑↓ select · p resume · esc back · s save'
  return '↑↓ select · esc back · s save'
}

export function workflowDetailSnapshotLines(task: LocalWorkflowTaskState, options: WorkflowDetailSnapshotOptions = {}): string[] {
  const showAgentDetail = Boolean(options.showAgentDetail && options.selectedAgentId)
  return [
    ...formatHeader(task),
    '',
    ...(showAgentDetail ? formatAgentDetailPanel(task, options.selectedAgentId!) : formatPhasePanel(task, options.selectedAgentId)),
    '',
    workflowDetailControlText(task, options),
  ]
}

export function formatWorkflowDetailSnapshot(task: LocalWorkflowTaskState, options: WorkflowDetailSnapshotOptions = {}): string {
  return workflowDetailSnapshotLines(task, options).join('\n')
}
