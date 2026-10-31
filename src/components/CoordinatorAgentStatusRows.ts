import type { AppState } from '../state/AppState.js'
import {
  isCompletedBackgroundAgent,
  isLocalAgentTask,
  isPanelAgentTask,
  type LocalAgentTaskState,
} from '../tasks/LocalAgentTask/LocalAgentTask.js'
import {
  workflowTerminalAgentCount,
  type LocalWorkflowTaskState,
} from '../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import {
  WORKFLOW_SIZE_WARNING_TEXT,
  workflowTaskSizeWarning,
} from '../tasks/LocalWorkflowTask/workflowSizeWarning.js'
import { isViewableTeammate } from '../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import type { InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js'
import { formatDuration, formatNumber } from '../utils/format.js'
import {
  AGENT_COLOR_TO_THEME_COLOR,
  AGENT_COLORS,
  type AgentColorName,
  getAgentColor,
} from '../tools/AgentTool/agentColorManager.js'
import { usageLimitStatusText } from '../tools/WorkflowTool/workflowUsageLimitWait.js'
import { PAUSE_ICON } from '../constants/figures.js'
import type { Theme } from '../utils/theme.js'

/** Official 2.1.311 folds idle teammates past the first three into one row. */
const IDLE_TEAMMATES_SHOWN = 3
export type CoordinatorIdleSummary = {
  type: 'idle_summary'
  id: 'idle-teammate-summary'
  taskIds: string[]
}
export type CoordinatorPanelTask =
  | LocalAgentTaskState
  | LocalWorkflowTaskState
  | InProcessTeammateTaskState
  | CoordinatorIdleSummary
export type CoordinatorPanelBranch = 'none' | 'middle' | 'last'

export type CoordinatorSessionRow = {
  id: string
  taskId?: string
  kind: 'main' | 'agent' | 'teammate' | 'workflow' | 'idle_summary'
  selected: boolean
  viewed: boolean
  icon: string
  primaryText: string
  secondaryText: string
  tokens: string
  tools: string
  elapsed: string
  statusText: string
  activity: string
  /** Official "Large workflow" size warning, shown while the run is over the agent/token cap. */
  warning?: string
  color?: keyof Theme
  depth: number
  branch: CoordinatorPanelBranch
}

type CoordinatorSessionRowsInput = {
  tasks: AppState['tasks']
  selectedIndex?: number
  viewingAgentTaskId?: string
  now?: number
  ultracodeActive?: boolean
  idleTeammatesExpanded?: boolean
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

function viewedLineage(
  tasks: AppState['tasks'],
  viewingAgentTaskId?: string,
): Set<string> {
  const ids = new Set<string>()
  let current = viewingAgentTaskId ? tasks[viewingAgentTaskId] : undefined
  while (isLocalAgentTask(current) && !ids.has(current.id)) {
    ids.add(current.id)
    current = current.parentAgentId ? tasks[current.parentAgentId] : undefined
  }
  return ids
}

/** Official footer adds "/tasks to see subagents" while finished agents sit off the panel. */
export function hasCompletedAgentsOffPanel(
  tasks: AppState['tasks'],
  viewingAgentTaskId?: string,
): boolean {
  const viewed = viewedLineage(tasks, viewingAgentTaskId)
  return Object.values(tasks).some(
    task =>
      isCompletedBackgroundAgent(task) &&
      task.evictAfter !== 0 &&
      !task.retain &&
      !viewed.has(task.id),
  )
}

function coordinatorAgents(
  tasks: AppState['tasks'],
  viewingAgentTaskId?: string,
): LocalAgentTaskState[] {
  const workflowToolUses = workflowToolUseIds(tasks)
  const viewed = viewedLineage(tasks, viewingAgentTaskId)
  const candidates = Object.values(tasks).filter(
    (task): task is LocalAgentTaskState =>
      isLocalAgentTask(task) &&
      task.agentType !== 'main-session' &&
      task.evictAfter !== 0 &&
      (!isCompletedBackgroundAgent(task) || task.retain || viewed.has(task.id)),
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

function sortByStartTime<T extends { startTime: number }>(tasks: T[]): T[] {
  return tasks.sort((a, b) => a.startTime - b.startTime)
}

function deriveCoordinatorPanelLayout(
  tasks: AppState['tasks'],
  viewingAgentTaskId?: string,
  idleTeammatesExpanded = false,
): CoordinatorPanelLayout {
  const agents = coordinatorAgents(tasks, viewingAgentTaskId)
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
  const teammates = Object.values(tasks).filter(isViewableTeammate)
  const rootTasks = sortByStartTime<
    LocalAgentTaskState | LocalWorkflowTaskState | InProcessTeammateTaskState
  >([...roots, ...workflows, ...teammates])
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
    if (task.type !== 'local_agent') {
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

  const collapsedIdleIds = idleTeammatesExpanded
    ? []
    : orderedEntries
        .map(entry => entry.task)
        .filter(
          task =>
            task.type === 'in_process_teammate' &&
            task.isIdle &&
            task.status === 'running' &&
            task.id !== viewingAgentTaskId,
        )
        .map(task => task.id)
        .slice(IDLE_TEAMMATES_SHOWN)
  const collapsedIdle = new Set(collapsedIdleIds)
  const foldedEntries = orderedEntries.flatMap(entry => {
    if (!collapsedIdle.has(entry.task.id)) return [entry]
    if (entry.task.id !== collapsedIdleIds[0]) return []
    const summary: CoordinatorIdleSummary = {
      type: 'idle_summary',
      id: 'idle-teammate-summary',
      taskIds: collapsedIdleIds,
    }
    return [{ task: summary, depth: 0, branch: 'none' as const }]
  })

  const entries = foldedEntries.map(entry => ({
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
  idleTeammatesExpanded = false,
): CoordinatorPanelTask[] {
  return deriveCoordinatorPanelLayout(
    tasks,
    viewingAgentTaskId,
    idleTeammatesExpanded,
  ).entries.map(entry => entry.task)
}

export function getCoordinatorTaskCount(
  tasks: AppState['tasks'],
  viewingAgentTaskId?: string,
  idleTeammatesExpanded = false,
): number {
  const layout = deriveCoordinatorPanelLayout(
    tasks,
    viewingAgentTaskId,
    idleTeammatesExpanded,
  )
  if (layout.entries.length === 0) return 0
  return layout.entries.length + (layout.omitMainRow ? 0 : 1)
}

export function getCoordinatorTaskAtIndex(
  tasks: AppState['tasks'],
  selectedIndex: number,
  viewingAgentTaskId?: string,
  idleTeammatesExpanded = false,
): CoordinatorPanelTask | undefined {
  const layout = deriveCoordinatorPanelLayout(
    tasks,
    viewingAgentTaskId,
    idleTeammatesExpanded,
  )
  return layout.entries[selectedIndex - (layout.omitMainRow ? 0 : 1)]?.task
}

export function getCoordinatorTaskIndex(
  tasks: AppState['tasks'],
  taskId: string,
  viewingAgentTaskId?: string,
  idleTeammatesExpanded = false,
): number | undefined {
  const layout = deriveCoordinatorPanelLayout(
    tasks,
    viewingAgentTaskId,
    idleTeammatesExpanded,
  )
  const taskIndex = layout.entries.findIndex(
    ({ task }) =>
      task.id === taskId ||
      (task.type === 'idle_summary' && task.taskIds.includes(taskId)),
  )
  if (taskIndex < 0) return undefined
  return taskIndex + (layout.omitMainRow ? 0 : 1)
}

export function resolveCoordinatorSelection(
  tasks: AppState['tasks'],
  targetId: string,
  viewingAgentTaskId?: string,
  idleTeammatesExpanded = false,
): { index: number; targetId?: string } {
  const targetIndex = getCoordinatorTaskIndex(
    tasks,
    targetId,
    viewingAgentTaskId,
    idleTeammatesExpanded,
  )
  if (targetIndex !== undefined) return { index: targetIndex, targetId }

  let current = tasks[targetId]
  const visited = new Set<string>()
  while (isLocalAgentTask(current) && !visited.has(current.id)) {
    visited.add(current.id)
    const index = getCoordinatorTaskIndex(
      tasks,
      current.id,
      viewingAgentTaskId,
      idleTeammatesExpanded,
    )
    if (index !== undefined) return { index, targetId: current.id }
    current = current.parentAgentId ? tasks[current.parentAgentId] : undefined
  }

  const viewedIndex = viewingAgentTaskId
    ? getCoordinatorTaskIndex(
        tasks,
        viewingAgentTaskId,
        viewingAgentTaskId,
        idleTeammatesExpanded,
      )
    : undefined
  if (viewedIndex !== undefined) {
    return { index: viewedIndex, targetId: viewingAgentTaskId }
  }
  return { index: 0 }
}

function taskElapsed(
  task: Exclude<CoordinatorPanelTask, CoordinatorIdleSummary>,
  now: number,
): string {
  const pausedMs = task.totalPausedMs ?? 0
  const elapsedMs = Math.max(
    0,
    task.status === 'running'
      ? now - task.startTime - pausedMs
      : (task.endTime ?? task.startTime) - task.startTime - pausedMs,
  )
  return formatDuration(elapsedMs)
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

function agentPrimaryText(
  task: LocalAgentTaskState,
  descendantCount: number,
): string {
  const descendants = descendantCount > 0 ? ` (+${descendantCount})` : ''
  return `${task.agentType}${descendants}`
}

function teammateThemeColor(color: string | undefined): keyof Theme | undefined {
  return color && AGENT_COLORS.includes(color as AgentColorName)
    ? AGENT_COLOR_TO_THEME_COLOR[color as AgentColorName]
    : undefined
}

// Official 2.1.311: idle and plan-approval states replace the clock, and
// queued messages are appended to it.
function teammateElapsed(task: InProcessTeammateTaskState, now: number): string {
  const queued = task.pendingUserMessages.length
  const state =
    task.status === 'running' && task.awaitingPlanApproval
      ? 'awaiting approval'
      : task.status === 'running' && task.isIdle
        ? 'idle'
        : taskElapsed(task, now)
  return queued > 0 ? `${state} · ${queued} queued` : state
}

function workflowPrimaryText(task: LocalWorkflowTaskState): string {
  return task.workflowName ?? task.description.replace(/^Workflow:\s*/i, '')
}

function workflowSecondaryText(task: LocalWorkflowTaskState): string {
  const primaryText = workflowPrimaryText(task)
  const description = task.meta?.description ?? task.description.replace(/^Workflow:\s*/i, '')
  return description === primaryText ? '' : description
}

export function getCoordinatorSessionRows({
  tasks,
  selectedIndex,
  viewingAgentTaskId,
  now = Date.now(),
  ultracodeActive = false,
  idleTeammatesExpanded = false,
}: CoordinatorSessionRowsInput): CoordinatorSessionRow[] {
  const layout = deriveCoordinatorPanelLayout(
    tasks,
    viewingAgentTaskId,
    idleTeammatesExpanded,
  )
  const taskRows = layout.entries.map((entry, index): CoordinatorSessionRow => {
    const task = entry.task
    const selected = selectedIndex === index + (layout.omitMainRow ? 0 : 1)
    if (task.type === 'idle_summary') {
      const count = task.taskIds.length
      return {
        id: task.id,
        kind: 'idle_summary',
        selected,
        viewed: false,
        icon: '◯',
        primaryText: `${count} idle ${count === 1 ? 'agent' : 'agents'}`,
        secondaryText: '',
        tokens: '',
        tools: '',
        elapsed: '',
        statusText: '',
        activity: '',
        depth: 0,
        branch: 'none',
      }
    }
    if (task.type === 'in_process_teammate') {
      const showTokens =
        !task.isIdle && !task.awaitingPlanApproval && (task.progress?.tokenCount ?? 0) > 0
      return {
        id: task.id,
        taskId: task.id,
        kind: 'teammate',
        selected,
        viewed: viewingAgentTaskId === task.id,
        icon:
          selected || (selectedIndex === undefined && viewingAgentTaskId === task.id)
            ? '⏺'
            : '◯',
        primaryText: task.identity.agentName,
        secondaryText: task.description,
        tokens: showTokens ? `${formatNumber(task.progress!.tokenCount)} tokens` : '',
        tools: `${task.progress?.toolUseCount ?? 0} ${task.progress?.toolUseCount === 1 ? 'tool' : 'tools'}`,
        elapsed: teammateElapsed(task, now),
        statusText: task.status === 'killed' ? 'stopped' : task.status,
        activity: task.status === 'running' ? activityText(task.progress?.lastActivity) ?? '' : '',
        color: teammateThemeColor(task.identity.color),
        depth: 0,
        branch: 'none',
      }
    }
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
        secondaryText: task.progress?.summary || task.description || task.id,
        tokens: `${formatNumber(task.progress?.tokenCount ?? 0)} tokens`,
        tools: `${task.progress?.toolUseCount ?? 0} ${task.progress?.toolUseCount === 1 ? 'tool' : 'tools'}`,
        elapsed: taskElapsed(task, now),
        statusText: task.status === 'killed' ? 'stopped' : task.status,
        activity: task.status === 'running' ? activityText(task.progress?.lastActivity) ?? '' : '',
        color: getAgentColor(task.agentType),
        depth: entry.depth,
        branch: entry.branch,
      }
    }
    const rateLimitWait = task.status === 'running' ? task.rateLimitWait : undefined
    return {
      id: task.id,
      taskId: task.id,
      kind: 'workflow',
      selected,
      viewed: false,
      icon: rateLimitWait ? PAUSE_ICON : '◯',
      primaryText: workflowPrimaryText(task),
      secondaryText: workflowSecondaryText(task),
      tokens: `${formatNumber(task.tokenCount ?? task.results.reduce((sum, result) => sum + (result.tokenCount ?? 0), 0))} tokens`,
      tools: `${workflowTerminalAgentCount(task)}/${task.agentCount ?? task.phases.reduce((sum, phase) => sum + phase.agentIds.length, 0)} agents`,
      elapsed: taskElapsed(task, now),
      statusText: rateLimitWait
        ? `paused · ${usageLimitStatusText(rateLimitWait.resetsAt)}`
        : task.status === 'completed' ? 'done' : task.status === 'killed' ? 'stopped' : task.status === 'pending' ? 'paused' : task.status,
      activity: '',
      ...(rateLimitWait ? { color: 'warning' as const } : {}),
      warning: workflowTaskSizeWarning(task, ultracodeActive) ? WORKFLOW_SIZE_WARNING_TEXT : undefined,
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
      tokens: '',
      tools: '',
      elapsed: '',
      statusText: '',
      activity: '',
      depth: 0,
      branch: 'none',
    },
    ...taskRows,
  ]
}
