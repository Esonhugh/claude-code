import {
  workflowTerminalAgentCount,
  type LocalWorkflowTaskState,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { TaskState } from '../../tasks/types.js'
import type { WorkflowRunSession } from '../../tools/WorkflowTool/workflowRunSessions.js'
import type { Theme } from '../../utils/theme.js'
import { formatDuration, formatNumber } from '../../utils/format.js'

export type WorkflowPageItem = {
  id: string
  task: LocalWorkflowTaskState
  source: 'live' | 'persisted'
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

function workflowTitle(task: LocalWorkflowTaskState): string {
  return task.workflowName ?? task.summary ?? task.description.replace(/^Workflow:\s*/i, '')
}

function visibleAgentTotal(task: LocalWorkflowTaskState): number {
  const started = task.phases.reduce((sum, phase) => sum + phase.agentIds.length, 0)
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

function toWorkflowPageItem(
  task: LocalWorkflowTaskState,
  source: WorkflowPageItem['source'],
): WorkflowPageItem {
  const completed = workflowTerminalAgentCount(task)
  const total = visibleAgentTotal(task)
  const { icon, color } = statusIcon(task.status)
  const tokenCount = task.tokenCount ?? task.results.reduce((sum, r) => sum + (r.tokenCount ?? 0), 0)
  const parts = [formatDuration(elapsedMs(task))]
  if (total > 0) parts.push(`${total} ${total === 1 ? 'agent' : 'agents'}`)
  if (tokenCount > 0) parts.push(`${formatNumber(tokenCount)} tok`)
  return {
    id: task.id,
    task,
    source,
    title: workflowTitle(task),
    status: task.status,
    completedAgents: completed,
    totalAgents: total,
    icon,
    iconColor: color,
    metricsText: parts.join(' · '),
  }
}

export function persistedWorkflowTask(
  session: WorkflowRunSession,
): LocalWorkflowTaskState {
  const phaseIds = [...new Set(session.results.map(result => result.phaseId))]
  return {
    id: session.taskId,
    type: 'local_workflow',
    status: session.status === 'paused'
      ? 'pending'
      : session.status === 'killed'
        ? 'killed'
        : session.status,
    description: `Workflow: ${session.workflowName}`,
    workflowName: session.workflowName,
    workflowRunId: session.workflowRunId,
    scriptPath: session.scriptPath,
    runArgs: session.runArgs,
    startTime: session.startedAt,
    endTime: session.status === 'running' || session.status === 'paused'
      ? undefined
      : session.updatedAt,
    outputFile: '',
    outputOffset: 0,
    notified: true,
    agentCount: session.agentCount ?? session.results.length,
    runtime: session.runtime,
    sourcePath: session.sourcePath,
    runScriptSnapshot: session.runScriptSnapshot,
    phases: phaseIds.map(phaseId => {
      const results = session.results.filter(result => result.phaseId === phaseId)
      return {
        id: phaseId,
        status: results.some(result => result.status === 'failed')
          ? 'failed' as const
          : results.every(result => result.status === 'skipped')
            ? 'skipped' as const
            : results.every(result => result.status === 'completed')
              ? 'completed' as const
              : 'running' as const,
        agentIds: results.map(result => result.agentId),
        completedAgentIds: results.filter(result => result.status === 'completed').map(result => result.agentId),
        skippedAgentIds: results.filter(result => result.status === 'skipped').map(result => result.agentId),
        failedAgentIds: results.filter(result => result.status === 'failed').map(result => result.agentId),
        results,
      }
    }),
    results: session.results,
    events: session.events,
    error: session.error,
  }
}

export function formatWorkflowEmptyState(): string {
  return 'No dynamic workflows in this session.'
}

export function getWorkflowPageItems(
  tasks: Record<string, TaskState> | Record<string, unknown> | undefined,
  persistedSessions: WorkflowRunSession[] = [],
  sessionId?: string,
): WorkflowPageItem[] {
  const live = Object.values(tasks ?? {}).filter(isLocalWorkflowTask)
  const liveIds = new Set(live.flatMap(task =>
    task.workflowRunId ? [task.id, task.workflowRunId] : [task.id],
  ))
  // Like official, persisted runs are listed only for the session that started them.
  const persisted = persistedSessions
    .filter(session => session.sessionId === sessionId)
    .filter(session => !liveIds.has(session.workflowRunId) && !liveIds.has(session.taskId))
    .map(session => toWorkflowPageItem(persistedWorkflowTask(session), 'persisted'))
  return [...live.map(task => toWorkflowPageItem(task, 'live')), ...persisted]
    .sort((a, b) => b.task.startTime - a.task.startTime)
}

export function runningCount(items: WorkflowPageItem[]): number {
  return items.filter(i => i.status === 'running').length
}

export function completedCount(items: WorkflowPageItem[]): number {
  return items.filter(i => i.status !== 'running').length
}
