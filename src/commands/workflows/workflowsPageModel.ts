import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { TaskState } from '../../tasks/types.js'
import type { Theme } from '../../utils/theme.js'
import { formatDuration, formatNumber } from '../../utils/format.js'

export type WorkflowPageItem = {
  id: string
  task: LocalWorkflowTaskState
  title: string
  status: LocalWorkflowTaskState['status']
  completedAgents: number
  totalAgents: number
  icon: string
  iconColor: keyof Theme | undefined
  metricsText: string
}

function isLocalWorkflowTask(task: unknown): task is LocalWorkflowTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'local_workflow'
  )
}

function completedAgents(task: LocalWorkflowTaskState): number {
  return task.phases.reduce(
    (sum, phase) => sum + phase.completedAgentIds.length,
    0,
  )
}

function workflowTitle(task: LocalWorkflowTaskState): string {
  return task.workflowName ?? task.summary ?? task.description.replace(/^Workflow:\s*/i, '')
}

function visibleAgentTotal(task: LocalWorkflowTaskState): number {
  const started = task.phases.reduce((sum, phase) => sum + phase.agentIds.length, 0)
  if ((task.status === 'running' || task.status === 'pending') && started > 0) return started
  return task.agentCount ?? started
}

function statusIcon(status: LocalWorkflowTaskState['status']): { icon: string; color: keyof Theme | undefined } {
  switch (status) {
    case 'completed': return { icon: '✓', color: 'success' }
    case 'failed':
    case 'killed': return { icon: '✗', color: 'error' }
    default: return { icon: '↻', color: undefined }
  }
}

function elapsedMs(task: LocalWorkflowTaskState): number {
  const pausedMs = task.totalPausedMs ?? 0
  const end = task.endTime ?? Date.now()
  return Math.max(0, end - task.startTime - pausedMs)
}

function toWorkflowPageItem(task: LocalWorkflowTaskState): WorkflowPageItem {
  const completed = completedAgents(task)
  const total = visibleAgentTotal(task)
  const { icon, color } = statusIcon(task.status)
  const tokenCount = task.tokenCount ?? task.results.reduce((sum, r) => sum + (r.tokenCount ?? 0), 0)
  const parts: string[] = []
  if (total > 0) parts.push(`${total} ${total === 1 ? 'agent' : 'agents'}`)
  if (tokenCount > 0) parts.push(`${formatNumber(tokenCount)} tok`)
  parts.push(formatDuration(elapsedMs(task)))
  return {
    id: task.id,
    task,
    title: workflowTitle(task),
    status: task.status,
    completedAgents: completed,
    totalAgents: total,
    icon,
    iconColor: color,
    metricsText: parts.join(' · '),
  }
}

export function formatWorkflowEmptyState(): string {
  return 'No dynamic workflows in this session.'
}

export function getWorkflowPageItems(
  tasks: Record<string, TaskState> | Record<string, unknown> | undefined,
): WorkflowPageItem[] {
  return Object.values(tasks ?? {})
    .filter(isLocalWorkflowTask)
    .map(toWorkflowPageItem)
    .sort((a, b) => b.task.startTime - a.task.startTime)
}

export function runningCount(items: WorkflowPageItem[]): number {
  return items.filter(i => i.status === 'running').length
}

export function completedCount(items: WorkflowPageItem[]): number {
  return items.filter(i => i.status !== 'running').length
}
