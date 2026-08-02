import { getSessionId } from 'src/bootstrap/state.js'
import type { AppState } from '../state/AppState.js'
import {
  isLocalAgentTask,
  isPanelAgentTask,
  type LocalAgentTaskState,
} from '../tasks/LocalAgentTask/LocalAgentTask.js'
import {
  workflowTerminalAgentCount,
  type LocalWorkflowTaskState,
} from '../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { formatDuration, formatNumber } from '../utils/format.js'

export type CoordinatorPanelTask = LocalAgentTaskState | LocalWorkflowTaskState
export type CoordinatorPanelBranch = 'none' | 'middle' | 'last'

export type CoordinatorSessionRow = {
  id: string
  taskId?: string
  kind: 'main' | 'agent' | 'workflow'
  selected: boolean
  viewed: boolean
  icon: string
  primaryText: string
  secondaryText: string
  meta: string
  statusText: string
  depth: number
  branch: CoordinatorPanelBranch
}

type CoordinatorSessionRowsInput = {
  tasks: AppState['tasks']
  selectedIndex?: number
  viewingAgentTaskId?: string
  now?: number
}

type CoordinatorPanelEntry = {
  task: CoordinatorPanelTask
  depth: number
  branch: CoordinatorPanelBranch
  collapsedDescendantCount: number
}

type CoordinatorPanelLayout = {
  entries: CoordinatorPanelEntry[]
  omitMainRow: boolean
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

function coordinatorAgents(tasks: AppState['tasks']): LocalAgentTaskState[] {
  const workflowToolUses = workflowToolUseIds(tasks)
  const candidates = Object.values(tasks).filter(
    (task): task is LocalAgentTaskState =>
      isLocalAgentTask(task) &&
      task.agentType !== 'main-session' &&
      task.evictAfter !== 0,
  )
  const workflowChildIds = new Set(
    candidates
      .filter(task => isWorkflowChildAgent(task, workflowToolUses))
      .map(task => task.id),
  )
  const agentById = new Map(candidates.map(task => [task.id, task]))

  return candidates.filter(task => {
    const visited = new Set<string>()
    let current: LocalAgentTaskState | undefined = task
    while (current && !visited.has(current.id)) {
      if (workflowChildIds.has(current.id)) return false
      visited.add(current.id)
      current = current.parentAgentId
        ? agentById.get(current.parentAgentId)
        : undefined
    }
    return true
  })
}

function sortByStartTime<T extends CoordinatorPanelTask>(tasks: T[]): T[] {
  return tasks.sort((a, b) => a.startTime - b.startTime)
}

function deriveCoordinatorPanelLayout(
  tasks: AppState['tasks'],
  viewingAgentTaskId?: string,
): CoordinatorPanelLayout {
  const agents = coordinatorAgents(tasks)
  const agentById = new Map(agents.map(task => [task.id, task]))
  const childrenByParentId = new Map<string, LocalAgentTaskState[]>()
  for (const agent of agents) {
    if (!agent.parentAgentId || agent.status !== 'running') continue
    const children = childrenByParentId.get(agent.parentAgentId) ?? []
    children.push(agent)
    childrenByParentId.set(agent.parentAgentId, children)
  }
  for (const children of childrenByParentId.values()) {
    sortByStartTime(children)
  }

  const roots = agents.filter(isPanelAgentTask)
  const workflows = Object.values(tasks).filter(isPanelWorkflowTask)
  const rootTasks = sortByStartTime<CoordinatorPanelTask>([
    ...roots,
    ...workflows,
  ])
  const visibleAgents = new Map<string, Omit<CoordinatorPanelEntry, 'collapsedDescendantCount'>>()

  const viewedAgent = viewingAgentTaskId
    ? agentById.get(viewingAgentTaskId)
    : undefined
  let focusedRootId: string | undefined
  if (viewedAgent && (viewedAgent.parentAgentId === undefined || viewedAgent.status === 'running')) {
    const path: LocalAgentTaskState[] = []
    const visited = new Set<string>()
    let current: LocalAgentTaskState | undefined = viewedAgent
    let validPath = true
    while (current) {
      if (visited.has(current.id)) {
        validPath = false
        break
      }
      visited.add(current.id)
      path.push(current)
      if (!current.parentAgentId) break
      const parent = agentById.get(current.parentAgentId)
      if (!parent || (parent.parentAgentId !== undefined && parent.status !== 'running')) {
        validPath = false
        break
      }
      current = parent
    }

    const root = path[path.length - 1]
    if (validPath && root && isPanelAgentTask(root)) {
      focusedRootId = root.id
      path.reverse().forEach((agent, index) => {
        visibleAgents.set(agent.id, {
          task: agent,
          depth: index,
          branch: index === 0 ? 'none' : 'last',
        })
      })
      const directChildren = childrenByParentId.get(viewedAgent.id) ?? []
      directChildren.forEach((child, index) => {
        visibleAgents.set(child.id, {
          task: child,
          depth: path.length,
          branch: index === directChildren.length - 1 ? 'last' : 'middle',
        })
      })
    } else {
      visibleAgents.set(viewedAgent.id, {
        task: viewedAgent,
        depth: 0,
        branch: 'none',
      })
    }
  }

  const orderedEntries: Omit<CoordinatorPanelEntry, 'collapsedDescendantCount'>[] = []
  const fallbackViewedAgent =
    viewedAgent && visibleAgents.has(viewedAgent.id) && !focusedRootId
      ? visibleAgents.get(viewedAgent.id)
      : undefined
  if (fallbackViewedAgent) orderedEntries.push(fallbackViewedAgent)

  for (const task of rootTasks) {
    if (task.type === 'local_workflow') {
      orderedEntries.push({ task, depth: 0, branch: 'none' })
      continue
    }
    const rootEntry = visibleAgents.get(task.id) ?? {
      task,
      depth: 0,
      branch: 'none' as const,
    }
    orderedEntries.push(rootEntry)
    if (task.id !== focusedRootId) continue
    for (const entry of visibleAgents.values()) {
      if (entry.task.id !== task.id) orderedEntries.push(entry)
    }
  }

  const visibleIds = new Set(orderedEntries.map(entry => entry.task.id))
  const countCollapsedDescendants = (
    taskId: string,
    visited = new Set<string>(),
  ): number => {
    if (visited.has(taskId)) return 0
    visited.add(taskId)
    return (childrenByParentId.get(taskId) ?? []).reduce((count, child) => {
      if (visibleIds.has(child.id)) return count
      return count + 1 + countCollapsedDescendants(child.id, visited)
    }, 0)
  }

  const entries = orderedEntries.map(entry => ({
    ...entry,
    collapsedDescendantCount:
      entry.task.type === 'local_agent'
        ? countCollapsedDescendants(entry.task.id)
        : 0,
  }))

  return {
    entries,
    omitMainRow:
      entries.length > 0 &&
      viewingAgentTaskId === undefined &&
      entries.every(entry => entry.task.type === 'local_workflow'),
  }
}

export function getVisibleAgentTasks(
  tasks: AppState['tasks'],
  viewingAgentTaskId?: string,
): CoordinatorPanelTask[] {
  return deriveCoordinatorPanelLayout(tasks, viewingAgentTaskId).entries.map(
    entry => entry.task,
  )
}

export function getCoordinatorTaskCount(
  tasks: AppState['tasks'],
  viewingAgentTaskId?: string,
): number {
  const layout = deriveCoordinatorPanelLayout(tasks, viewingAgentTaskId)
  if (layout.entries.length === 0) return 0
  return layout.entries.length + (layout.omitMainRow ? 0 : 1)
}

export function getCoordinatorTaskAtIndex(
  tasks: AppState['tasks'],
  selectedIndex: number,
  viewingAgentTaskId?: string,
): CoordinatorPanelTask | undefined {
  const layout = deriveCoordinatorPanelLayout(tasks, viewingAgentTaskId)
  return layout.entries[selectedIndex - (layout.omitMainRow ? 0 : 1)]?.task
}

export function getCoordinatorTaskIndex(
  tasks: AppState['tasks'],
  taskId: string,
  viewingAgentTaskId?: string,
): number | undefined {
  const layout = deriveCoordinatorPanelLayout(tasks, viewingAgentTaskId)
  const taskIndex = layout.entries.findIndex(entry => entry.task.id === taskId)
  if (taskIndex < 0) return undefined
  return taskIndex + (layout.omitMainRow ? 0 : 1)
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

function agentPrimaryText(
  task: LocalAgentTaskState,
  descendantCount: number,
): string {
  const descendants = descendantCount > 0 ? ` (+${descendantCount})` : ''
  return `${task.agentType}${descendants}`
}

function workflowPrimaryText(task: LocalWorkflowTaskState): string {
  return task.workflowName ?? task.description.replace(/^Workflow:\s*/i, '')
}

function workflowSecondaryText(task: LocalWorkflowTaskState): string {
  const primaryText = workflowPrimaryText(task)
  const description = task.meta?.description ?? task.description.replace(/^Workflow:\s*/i, '')
  return description === primaryText ? '' : description
}

function agentRowMeta(task: LocalAgentTaskState): string {
  const tokenCount = task.progress?.tokenCount ?? 0
  const toolUseCount = task.progress?.toolUseCount ?? 0
  return `${formatNumber(tokenCount)} tok · ${toolUseCount} ${toolUseCount === 1 ? 'tool' : 'tools'}`
}

function workflowRowMeta(task: LocalWorkflowTaskState): string {
  const completed = workflowTerminalAgentCount(task)
  const started = task.phases.reduce((sum, phase) => sum + phase.agentIds.length, 0)
  const total = task.agentCount ?? started
  const tokenCount = task.tokenCount ?? task.results.reduce((sum, result) => sum + (result.tokenCount ?? 0), 0)
  return `${completed}/${total} agents · ${formatNumber(tokenCount)} tok`
}

export function getCoordinatorSessionRows({
  tasks,
  selectedIndex,
  viewingAgentTaskId,
  now = Date.now(),
}: CoordinatorSessionRowsInput): CoordinatorSessionRow[] {
  const layout = deriveCoordinatorPanelLayout(tasks, viewingAgentTaskId)
  const taskRows = layout.entries.map((entry, index): CoordinatorSessionRow => {
    const task = entry.task
    const selected = selectedIndex === index + (layout.omitMainRow ? 0 : 1)
    if (task.type === 'local_agent') {
      return {
        id: task.id,
        taskId: task.id,
        kind: 'agent',
        selected,
        viewed: viewingAgentTaskId === task.id,
        icon:
          selected || (selectedIndex === undefined && viewingAgentTaskId === task.id)
            ? '⏺'
            : '◯',
        primaryText: agentPrimaryText(
          task,
          entry.collapsedDescendantCount,
        ),
        secondaryText: task.description ?? task.id,
        meta: agentRowMeta(task),
        statusText: agentStatusText(task, now),
        depth: entry.depth,
        branch: entry.branch,
      }
    }
    return {
      id: task.id,
      taskId: task.id,
      kind: 'workflow',
      selected,
      viewed: false,
      icon: '◯',
      primaryText: workflowPrimaryText(task),
      secondaryText: workflowSecondaryText(task),
      meta: workflowRowMeta(task),
      statusText: workflowStatusText(task, now),
      depth: 0,
      branch: 'none',
    }
  })

  if (layout.omitMainRow) return taskRows
  return [
    {
      id: 'main',
      taskId: undefined,
      kind: 'main',
      selected: selectedIndex === 0,
      viewed: viewingAgentTaskId === undefined,
      icon: viewingAgentTaskId === undefined ? '●' : '○',
      primaryText: 'main',
      secondaryText: '',
      meta: '',
      statusText: 'current session',
      depth: 0,
      branch: 'none',
    },
    ...taskRows,
  ]
}
