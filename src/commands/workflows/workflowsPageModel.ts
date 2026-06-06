import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { TaskState } from '../../tasks/types.js'

export type WorkflowPageItem = {
  id: string
  title: string
  status: LocalWorkflowTaskState['status']
  completedAgents: number
  totalAgents: number
  progressLabel: string
  metricsLabel: string
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
  return task.workflowName ?? task.description.replace(/^Workflow:\s*/i, '')
}

function formatCount(value: number, singular: string, plural: string): string {
  return `${value.toLocaleString('en-US')} ${value === 1 ? singular : plural}`
}

function toWorkflowPageItem(task: LocalWorkflowTaskState): WorkflowPageItem {
  const completed = completedAgents(task)
  const total = task.agentCount ?? task.phases.reduce(
    (sum, phase) => sum + phase.agentIds.length,
    0,
  )
  return {
    id: task.id,
    title: workflowTitle(task),
    status: task.status,
    completedAgents: completed,
    totalAgents: total,
    progressLabel: `${completed}/${total} agents`,
    metricsLabel: `${formatCount(task.tokenCount ?? 0, 'token', 'tokens')} · ${formatCount(task.toolUseCount ?? 0, 'tool use', 'tool uses')}`,
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
    .sort((a, b) => {
      if (a.status === 'running' && b.status !== 'running') return -1
      if (a.status !== 'running' && b.status === 'running') return 1
      return 0
    })
}

export function formatWorkflowListRow(
  item: WorkflowPageItem,
  selected: boolean,
): string {
  return `${selected ? '›' : ' '} ${item.title} — ${item.status} — ${item.progressLabel} — ${item.metricsLabel}`
}
