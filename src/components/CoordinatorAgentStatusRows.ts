import type { AppState } from '../state/AppState.js'
import type { LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import type { LocalWorkflowTaskState } from '../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { formatDuration, formatNumber } from '../utils/format.js'

export type CoordinatorPanelTask = LocalAgentTaskState | LocalWorkflowTaskState

export type CoordinatorSessionRow = {
  id: string
  taskId?: string
  kind: 'main' | 'agent' | 'workflow'
  selected: boolean
  viewed: boolean
  icon: string
  label: string
  meta: string
  statusText: string
}

type CoordinatorSessionRowsInput = {
  tasks: AppState['tasks']
  selectedIndex?: number
  viewingAgentTaskId?: string
  nameByAgentId: Map<string, string>
  now?: number
  omitMainRow?: boolean
}

function isPanelAgentTask(t: unknown): t is LocalAgentTaskState {
  return (
    typeof t === 'object' &&
    t !== null &&
    'type' in t &&
    t.type === 'local_agent' &&
    !('agentType' in t && t.agentType === 'main-session')
  )
}

function isPanelWorkflowTask(t: unknown): t is LocalWorkflowTaskState {
  return (
    typeof t === 'object' &&
    t !== null &&
    'type' in t &&
    t.type === 'local_workflow'
  )
}

function workflowToolUseIds(tasks: AppState['tasks']): Set<string> {
  return new Set(
    Object.values(tasks)
      .filter(isPanelWorkflowTask)
      .map(task => task.toolUseId)
      .filter((toolUseId): toolUseId is string => Boolean(toolUseId)),
  )
}

function isWorkflowChildAgent(
  task: LocalAgentTaskState,
  workflowToolUses: Set<string>,
): boolean {
  return Boolean(task.toolUseId && workflowToolUses.has(task.toolUseId))
}

export function getVisibleAgentTasks(
  tasks: AppState['tasks'],
): CoordinatorPanelTask[] {
  const workflowToolUses = workflowToolUseIds(tasks)
  return Object.values(tasks)
    .filter(
      (t): t is CoordinatorPanelTask =>
        (isPanelAgentTask(t) && t.evictAfter !== 0 && !isWorkflowChildAgent(t, workflowToolUses)) || isPanelWorkflowTask(t),
    )
    .sort((a, b) => a.startTime - b.startTime)
}

function taskElapsed(task: CoordinatorPanelTask, now: number): string {
  const pausedMs = task.totalPausedMs ?? 0
  const elapsedMs = Math.max(
    0,
    task.status === 'running'
      ? now - task.startTime - pausedMs
      : (task.endTime ?? task.startTime) - task.startTime - pausedMs,
  )
  return formatDuration(elapsedMs)
}

function workflowCompletedAgents(task: LocalWorkflowTaskState): number {
  return task.phases.reduce((sum, phase) => sum + phase.completedAgentIds.length, 0)
}

function workflowStatusText(task: LocalWorkflowTaskState, now: number): string {
  if (task.status === 'completed') return `done · ${taskElapsed(task, now)}`
  if (task.status === 'failed') return `failed · ${taskElapsed(task, now)}`
  if (task.status === 'killed') return `killed · ${taskElapsed(task, now)}`
  if (task.status === 'pending') return `paused · ${taskElapsed(task, now)}`
  return `running · ${taskElapsed(task, now)}`
}

function activityText(activity: unknown): string | undefined {
  if (!activity) return undefined
  if (typeof activity === 'string') return activity
  if (typeof activity !== 'object') return undefined
  const description = (activity as { activityDescription?: unknown }).activityDescription
  if (typeof description === 'string' && description.trim() !== '') return description
  const toolName = (activity as { toolName?: unknown }).toolName
  return typeof toolName === 'string' && toolName.trim() !== '' ? toolName : undefined
}

function agentStatusText(task: LocalAgentTaskState, now: number): string {
  const prefix = task.status === 'running' ? 'running' : task.status
  const activity = activityText(task.progress?.lastActivity)
  return activity ? `${prefix} · ${activity}` : `${prefix} · ${taskElapsed(task, now)}`
}

function taskIcon(task: CoordinatorPanelTask): string {
  if (task.status === 'completed') return '✔'
  if (task.status === 'failed' || task.status === 'killed') return '✖'
  if (task.status === 'pending') return '⏸'
  return '●'
}

function agentRowLabel(task: LocalAgentTaskState, nameByAgentId: Map<string, string>): string {
  return `agent ${nameByAgentId.get(task.id) ?? task.description ?? task.id}`
}

function workflowRowLabel(task: LocalWorkflowTaskState): string {
  return task.workflowName ?? task.description.replace(/^Workflow:\s*/i, '')
}

function agentRowMeta(task: LocalAgentTaskState): string {
  const tokenCount = task.progress?.tokenCount ?? 0
  const toolUseCount = task.progress?.toolUseCount ?? 0
  return `${formatNumber(tokenCount)} tok · ${toolUseCount} ${toolUseCount === 1 ? 'tool' : 'tools'}`
}

function workflowRowMeta(task: LocalWorkflowTaskState): string {
  const completed = workflowCompletedAgents(task)
  const started = task.phases.reduce((sum, phase) => sum + phase.agentIds.length, 0)
  const total = (task.status === 'running' || task.status === 'pending') && started > 0
    ? started
    : task.agentCount ?? started
  const tokenCount = task.tokenCount ?? task.results.reduce((sum, result) => sum + (result.tokenCount ?? 0), 0)
  return `${completed}/${total} agents · ${formatNumber(tokenCount)} tok`
}

export function getCoordinatorSessionRows({
  tasks,
  selectedIndex,
  viewingAgentTaskId,
  nameByAgentId,
  now = Date.now(),
  omitMainRow = false,
}: CoordinatorSessionRowsInput): CoordinatorSessionRow[] {
  const visibleTasks = getVisibleAgentTasks(tasks)
  const taskRows = visibleTasks.map((task, index): CoordinatorSessionRow => {
    const selected = selectedIndex === index + (omitMainRow ? 0 : 1)
    if (task.type === 'local_agent') {
      return {
        id: task.id,
        taskId: task.id,
        kind: 'agent',
        selected,
        viewed: viewingAgentTaskId === task.id,
        icon: taskIcon(task),
        label: agentRowLabel(task, nameByAgentId),
        meta: agentRowMeta(task),
        statusText: agentStatusText(task, now),
      }
    }
    return {
      id: task.id,
      taskId: task.id,
      kind: 'workflow',
      selected,
      viewed: false,
      icon: taskIcon(task),
      label: workflowRowLabel(task),
      meta: workflowRowMeta(task),
      statusText: workflowStatusText(task, now),
    }
  })

  if (omitMainRow) return taskRows
  return [
    {
      id: 'main',
      taskId: undefined,
      kind: 'main',
      selected: selectedIndex === 0,
      viewed: viewingAgentTaskId === undefined,
      icon: viewingAgentTaskId === undefined ? '●' : '○',
      label: 'main',
      meta: '',
      statusText: 'current session',
    },
    ...taskRows,
  ]
}
