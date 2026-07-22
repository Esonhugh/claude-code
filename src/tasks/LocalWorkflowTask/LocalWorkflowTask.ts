import { randomBytes } from 'node:crypto'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { enqueueSdkEvent } from '../../utils/sdkEventQueue.js'
import type {
  WorkflowArgs,
  WorkflowDryRunPhase,
  WorkflowDryRunPlan,
  WorkflowProgressEvent,
  WorkflowRuntimeSpec,
} from '../../tools/WorkflowTool/workflowSpec.js'
import type { WorkflowScriptMeta } from '../../tools/WorkflowTool/workflowScriptParser.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { SetAppState, Task, TaskStateBase } from '../../Task.js'

const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const MAX_RECENT_ACTIVITIES = 5
export const WORKFLOW_AGENT_USER_RETRY_ABORT_REASON = 'user-retry'
export const WORKFLOW_AGENT_SKIPPED_ABORT_REASON = 'user-skip'

function generateWorkflowTaskId(): string {
  const bytes = randomBytes(8)
  let id = 'w'
  for (let i = 0; i < 8; i++) {
    id += TASK_ID_ALPHABET[bytes[i]! % TASK_ID_ALPHABET.length]
  }
  return id
}

function createWorkflowTaskBase(
  id: string,
  description: string,
  toolUseId?: string,
): TaskStateBase {
  return {
    id,
    type: 'local_workflow',
    status: 'pending',
    description,
    toolUseId,
    startTime: Date.now(),
    outputFile: getTaskOutputPath(id),
    outputOffset: 0,
    notified: false,
  }
}

function terminalStatus(status: LocalWorkflowTaskState['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

function workflowAgentIsControllable(task: LocalWorkflowTaskState, agentId: string): boolean {
  const controller = task.agentControllers?.[agentId]
  if (!controller) return false
  const phase = task.phases.find(currentPhase => currentPhase.agentIds.includes(agentId))
  if (!phase) return false
  if (
    phase.completedAgentIds.includes(agentId) ||
    phase.failedAgentIds.includes(agentId) ||
    phase.skippedAgentIds.includes(agentId)
  ) return false
  const index = phase.agentIds.indexOf(agentId)
  const result = phase.results.find(currentResult => currentResult.index === index)
  return !result || result.status === 'running'
}

export type WorkflowPhaseStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'

export type WorkflowAgentErrorKind =
  | 'concurrency_limit'
  | 'stalled'
  | 'permission_denied'
  | 'agent_failed'

export type WorkflowAgentResult = {
  phaseId: string
  agentId: string
  index: number
  status: 'completed' | 'failed' | 'skipped' | 'running'
  output?: string
  error?: string
  errorKind?: WorkflowAgentErrorKind
  prompt?: string
  tokenCount?: number
  toolUseCount?: number
  durationMs?: number
}

export type WorkflowAgentAttemptState = {
  attemptId: string
  logicalAgentId: string
  agentId: string
  phaseId: string
  index?: number
  attempt: number
  retryOfAttemptId?: string
  status: 'running' | 'completed' | 'failed' | 'skipped' | 'interrupted'
  error?: string
}

export type WorkflowChildAgentSummary = {
  completed: number
  failed: number
  skipped: number
  running: number
  live: number
  concurrencyBlocked: number
  liveActivities: string[]
}

export type LocalWorkflowPhaseState = {
  id: string
  status: WorkflowPhaseStatus
  agentIds: string[]
  completedAgentIds: string[]
  skippedAgentIds: string[]
  failedAgentIds: string[]
  results: WorkflowAgentResult[]
  error?: string
}

export type WorkflowLiveAgentState = {
  tokenCount: number
  toolUseCount: number
  prompt?: string
  activity?: string
  recentActivities?: string[]
}

export type WorkflowAgentControllerState = {
  abortController: AbortController
  baseAgentId?: string
  index?: number
  userRetryAttempt?: number
}

export type LocalWorkflowTaskState = TaskStateBase & {
  type: 'local_workflow'
  currentAgentId?: string
  agentControllers?: Record<string, WorkflowAgentControllerState>
  liveAgents?: Record<string, WorkflowLiveAgentState>
  workflowName?: string
  workflowRunId?: string
  scriptPath?: string
  runArgs?: WorkflowArgs
  summary?: string
  agentCount?: number
  plannedMaxAgents?: number
  startedAgentAttempts?: number
  retryCount?: number
  agentAttempts?: WorkflowAgentAttemptState[]
  progressVersion?: number
  defaultModel?: string
  tokenCount?: number
  toolUseCount?: number
  execution?: 'agent' | 'team'
  teamName?: string
  runtime?: WorkflowRuntimeSpec
  meta?: WorkflowScriptMeta
  sourcePath?: string
  runScriptSnapshot?: string
  prompt?: string
  pausedAt?: number
  abortController?: AbortController
  phases: LocalWorkflowPhaseState[]
  results: WorkflowAgentResult[]
  events: WorkflowProgressEvent[]
  error?: string
}

function createPhaseState(phase: WorkflowDryRunPhase): LocalWorkflowPhaseState {
  return {
    id: phase.id,
    status: 'pending',
    agentIds: [],
    completedAgentIds: [],
    skippedAgentIds: [],
    failedAgentIds: [],
    results: [],
  }
}

export function registerWorkflowTask({
  plan,
  setAppState,
  toolUseId,
  runArgs,
  teamName,
  workflowRunId,
  scriptPath,
  defaultModel,
  dynamicAgentCount = false,
}: {
  plan: WorkflowDryRunPlan
  setAppState: SetAppState
  toolUseId?: string
  runArgs?: WorkflowArgs
  teamName?: string
  workflowRunId?: string
  scriptPath?: string
  defaultModel?: string
  dynamicAgentCount?: boolean
}): LocalWorkflowTaskState {
  const id = generateWorkflowTaskId()
  const taskState: LocalWorkflowTaskState = {
    ...createWorkflowTaskBase(id, plan.description, toolUseId),
    type: 'local_workflow',
    status: 'running',
    workflowName: plan.name,
    workflowRunId,
    scriptPath,
    runArgs,
    summary: 'Workflow started',
    agentCount: dynamicAgentCount ? 0 : plan.totalAgents,
    plannedMaxAgents: plan.totalAgents,
    startedAgentAttempts: 0,
    retryCount: 0,
    agentAttempts: [],
    progressVersion: 1,
    defaultModel: plan.defaults.model ?? defaultModel,
    tokenCount: 0,
    toolUseCount: 0,
    execution: plan.defaults.execution,
    teamName,
    runtime: plan.runtime,
    meta: plan.meta,
    sourcePath: plan.sourcePath,
    runScriptSnapshot: plan.runScriptSnapshot,
    prompt: plan.runScriptSnapshot,
    abortController: new AbortController(),
    phases: plan.phases.map(createPhaseState),
    results: [],
    events: [],
  }

  setAppState(prev => ({
    ...prev,
    tasks: {
      ...prev.tasks,
      [taskState.id]: taskState,
    },
  }))
  enqueueSdkEvent({
    type: 'system',
    subtype: 'task_started',
    task_id: taskState.id,
    tool_use_id: taskState.toolUseId,
    description: taskState.description,
    task_type: taskState.type,
    workflow_name: taskState.workflowName,
    prompt: taskState.prompt,
  })
  return taskState
}

function withWorkflowTask(
  taskId: string,
  setAppState: SetAppState,
  updater: (task: LocalWorkflowTaskState) => LocalWorkflowTaskState,
): void {
  setAppState(prev => {
    const task = prev.tasks?.[taskId]
    if (!task || task.type !== 'local_workflow') return prev
    const updated = updater(task)
    if (updated === task) return prev
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: updated,
      },
    }
  })
}

function bumpProgressVersion(task: LocalWorkflowTaskState): LocalWorkflowTaskState {
  return {
    ...task,
    progressVersion: (task.progressVersion ?? 0) + 1,
  }
}

function withProgressVersion(task: LocalWorkflowTaskState): LocalWorkflowTaskState {
  return bumpProgressVersion(task)
}

function updatePhase(
  task: LocalWorkflowTaskState,
  phaseId: string,
  updater: (phase: LocalWorkflowPhaseState) => LocalWorkflowPhaseState,
): LocalWorkflowTaskState {
  const exists = task.phases.some(phase => phase.id === phaseId)
  const phases = exists
    ? task.phases.map(phase => phase.id === phaseId ? updater(phase) : phase)
    : [...task.phases, updater({
        id: phaseId, status: 'pending', agentIds: [],
        completedAgentIds: [], skippedAgentIds: [], failedAgentIds: [], results: [],
      })]
  return withProgressVersion({ ...task, phases })
}

function addUnique(values: string[], value: string): string[] {
  return values.includes(value) ? values : [...values, value]
}

function agentIdsByAttemptIndex(
  task: LocalWorkflowTaskState,
  phaseId: string,
  values: string[],
  value: string,
  index?: number,
): string[] {
  if (values.includes(value)) return values
  const indexes = new Map(
    (task.agentAttempts ?? [])
      .filter(attempt => attempt.phaseId === phaseId && attempt.index !== undefined)
      .map(attempt => [attempt.agentId, attempt.index] as const),
  )
  if (index !== undefined) indexes.set(value, index)
  return [...values, value].sort(
    (left, right) =>
      (indexes.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (indexes.get(right) ?? Number.MAX_SAFE_INTEGER),
  )
}

function removeValue(values: string[], value: string): string[] {
  return values.filter(item => item !== value)
}

function removePhaseResultsForIndex(
  results: WorkflowAgentResult[],
  index: number,
): WorkflowAgentResult[] {
  return results.filter(result => result.index !== index)
}

function removeTaskResultsForPhaseIndex(
  results: WorkflowAgentResult[],
  phaseId: string,
  index: number,
): WorkflowAgentResult[] {
  return results.filter(
    result => result.phaseId !== phaseId || result.index !== index,
  )
}

export function workflowPhaseTerminalAgentCount(
  phase: LocalWorkflowPhaseState,
): number {
  const terminalIndexes = new Set(
    phase.results.flatMap(result =>
      result.status === 'completed' || result.status === 'failed' || result.status === 'skipped'
        ? [result.index]
        : [],
    ),
  )
  for (const agentId of [
    ...phase.completedAgentIds,
    ...phase.failedAgentIds,
    ...phase.skippedAgentIds,
  ]) {
    const index = phase.agentIds.indexOf(agentId)
    if (index >= 0) terminalIndexes.add(index)
  }
  return terminalIndexes.size
}

export function workflowTerminalAgentCount(
  task: LocalWorkflowTaskState,
): number {
  return task.phases.reduce(
    (sum, phase) => sum + workflowPhaseTerminalAgentCount(phase),
    0,
  )
}

function phaseCompleted(phase: LocalWorkflowPhaseState): boolean {
  return (
    phase.agentIds.length > 0 &&
    phase.failedAgentIds.length === 0 &&
    workflowPhaseTerminalAgentCount(phase) >= phase.agentIds.length
  )
}

export function getWorkflowChildAgentSummary(
  task: LocalWorkflowTaskState,
): WorkflowChildAgentSummary {
  const liveAgentIds = new Set(Object.keys(task.liveAgents ?? {}))
  const summary: WorkflowChildAgentSummary = {
    completed: 0,
    failed: 0,
    skipped: 0,
    running: 0,
    live: liveAgentIds.size,
    concurrencyBlocked: 0,
    liveActivities: [],
  }

  for (const result of task.results) {
    if (result.status === 'completed') summary.completed++
    else if (result.status === 'failed') summary.failed++
    else if (result.status === 'skipped') summary.skipped++
    else if (result.status === 'running') summary.running++
    if (result.errorKind === 'concurrency_limit') summary.concurrencyBlocked++
  }

  for (const liveAgent of Object.values(task.liveAgents ?? {})) {
    if (liveAgent.activity) summary.liveActivities.push(liveAgent.activity)
  }

  return summary
}

function appendEvent(
  task: LocalWorkflowTaskState,
  event: WorkflowProgressEvent,
): LocalWorkflowTaskState {
  return withProgressVersion({
    ...task,
    events: [...task.events, event],
  })
}

function progressEvent(
  task: LocalWorkflowTaskState,
  status: Extract<WorkflowProgressEvent, { type: 'workflow_progress' }>['status'],
): WorkflowProgressEvent {
  return {
    type: 'workflow_progress',
    workflowRunId: task.workflowRunId ?? task.id,
    status,
    completedAgents: workflowTerminalAgentCount(task),
    totalAgents: task.agentCount ?? 0,
    timestamp: Date.now(),
  }
}

function agentEvent(
  task: LocalWorkflowTaskState,
  phaseId: string,
  agentId: string,
  status: Extract<WorkflowProgressEvent, { type: 'workflow_agent' }>['status'],
): WorkflowProgressEvent {
  return {
    type: 'workflow_agent',
    workflowRunId: task.workflowRunId ?? task.id,
    phaseId,
    agentId,
    status,
    timestamp: Date.now(),
  }
}

export function workflowResumeCall(task: LocalWorkflowTaskState): string | undefined {
  if (!task.workflowRunId) return undefined
  const workflowRunId = JSON.stringify(task.workflowRunId)
  if (task.scriptPath?.startsWith('bundled:')) {
    const workflowName = task.scriptPath.slice('bundled:'.length) || task.workflowName
    return `Workflow({name: ${JSON.stringify(workflowName)}, resumeFromRunId: ${workflowRunId}})`
  }
  if (task.scriptPath) {
    return `Workflow({scriptPath: ${JSON.stringify(task.scriptPath)}, resumeFromRunId: ${workflowRunId}})`
  }
  if (task.workflowName) {
    const args = task.runArgs === undefined
      ? ''
      : `, args: ${JSON.stringify(task.runArgs)}`
    return `Workflow({name: ${JSON.stringify(task.workflowName)}${args}, resumeFromRunId: ${workflowRunId}})`
  }
  return undefined
}

function buildResumePrompt(task: LocalWorkflowTaskState): string {
  return `Resume the paused workflow by calling: ${workflowResumeCall(task) ?? 'Workflow resume unavailable'}`
}

export function recordWorkflowEvent({
  taskId,
  event,
  setAppState,
}: {
  taskId: string
  event: WorkflowProgressEvent
  setAppState: SetAppState
}): void {
  withWorkflowTask(taskId, setAppState, task => withProgressVersion({
    ...task,
    events: [...task.events, event],
  }))
}

export function startWorkflowPhase(
  taskId: string,
  phaseId: string,
  setAppState: SetAppState,
): void {
  withWorkflowTask(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    return updatePhase(task, phaseId, phase => ({ ...phase, status: 'running' }))
  })
}

export function recordWorkflowAgentStarted({
  taskId,
  phaseId,
  agentId,
  setAppState,
  logicalAgentId = agentId,
  attempt = 0,
  retryOfAttemptId,
  recordAttempt = true,
  index,
}: {
  taskId: string
  phaseId: string
  agentId: string
  setAppState: SetAppState
  logicalAgentId?: string
  attempt?: number
  retryOfAttemptId?: string
  recordAttempt?: boolean
  index?: number
}): void {
  withWorkflowTask(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    const hasLogicalAgent = task.agentAttempts?.some(current =>
      current.phaseId === phaseId && current.logicalAgentId === logicalAgentId,
    ) ?? task.phases.some(phase => phase.agentIds.includes(agentId))
    const isNewAgent = !hasLogicalAgent
    const attemptId = `${phaseId}:${logicalAgentId}:attempt:${attempt}`
    const isNewAttempt = recordAttempt && !task.agentAttempts?.some(current => current.attemptId === attemptId)
    const priorAttempt = task.agentAttempts?.findLast(current =>
      current.phaseId === phaseId &&
      current.logicalAgentId === logicalAgentId &&
      current.attempt < attempt,
    )
    const updated = updatePhase(
      {
        ...task,
        currentAgentId: agentId,
        agentCount: isNewAgent
          ? Math.max(task.agentCount ?? 0, task.phases.reduce((count, phase) => count + phase.agentIds.length, 0) + 1)
          : task.agentCount,
        startedAgentAttempts: (task.startedAgentAttempts ?? 0) + (isNewAttempt ? 1 : 0),
        retryCount: (task.retryCount ?? 0) + (isNewAttempt && attempt > 0 ? 1 : 0),
        agentAttempts: isNewAttempt
          ? [
              ...(task.agentAttempts ?? []).map(current =>
                current.phaseId === phaseId &&
                current.logicalAgentId === logicalAgentId &&
                current.status === 'running'
                  ? { ...current, status: 'interrupted' as const, error: 'retried' }
                  : current,
              ),
              {
                attemptId,
                logicalAgentId,
                agentId,
                phaseId,
                index,
                attempt,
                retryOfAttemptId,
                status: 'running',
              },
            ]
          : task.agentAttempts,
      },
      phaseId,
      phase => ({
        ...phase,
        status: 'running',
        agentIds: agentIdsByAttemptIndex(
          task,
          phaseId,
          priorAttempt
            ? phase.agentIds.map(current => current === priorAttempt.agentId ? agentId : current)
            : phase.agentIds,
          agentId,
          index,
        ),
        failedAgentIds: priorAttempt
          ? removeValue(phase.failedAgentIds, priorAttempt.agentId)
          : phase.failedAgentIds,
        skippedAgentIds: priorAttempt
          ? removeValue(phase.skippedAgentIds, priorAttempt.agentId)
          : phase.skippedAgentIds,
        completedAgentIds: priorAttempt
          ? removeValue(phase.completedAgentIds, priorAttempt.agentId)
          : phase.completedAgentIds,
        results: priorAttempt
          ? removePhaseResultsForIndex(phase.results, phase.agentIds.indexOf(priorAttempt.agentId))
          : phase.results,
        error: priorAttempt ? undefined : phase.error,
      }),
    )
    const retainedAgentState = priorAttempt
      ? removeLiveAgentState(updated, [priorAttempt.agentId])
      : {
          liveAgents: updated.liveAgents,
          agentControllers: updated.agentControllers,
        }
    // Register a liveAgents entry so the agent shows as 'running' in UI
    return {
      ...updated,
      ...retainedAgentState,
      liveAgents: {
        ...retainedAgentState.liveAgents,
        [agentId]: retainedAgentState.liveAgents?.[agentId] ?? { tokenCount: 0, toolUseCount: 0 },
      },
    }
  })
}

function updateWorkflowAgentAttempt(
  task: LocalWorkflowTaskState,
  agentId: string,
  status: WorkflowAgentAttemptState['status'],
  error?: string,
): Pick<LocalWorkflowTaskState, 'agentAttempts'> {
  const agentAttempts = task.agentAttempts ?? []
  const attemptIndex = agentAttempts.findLastIndex(attempt => attempt.agentId === agentId && attempt.status === 'running')
  if (attemptIndex < 0) return { agentAttempts }
  return {
    agentAttempts: agentAttempts.map((attempt, index) =>
      index === attemptIndex ? { ...attempt, status, ...(error ? { error } : {}) } : attempt,
    ),
  }
}

export function recordWorkflowAgentController({
  taskId,
  agentId,
  abortController,
  setAppState,
  baseAgentId,
  index,
  userRetryAttempt,
}: {
  taskId: string
  agentId: string
  abortController: AbortController
  setAppState: SetAppState
  baseAgentId?: string
  index?: number
  userRetryAttempt?: number
}): void {
  withWorkflowTask(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    return withProgressVersion({
      ...task,
      agentControllers: {
        ...task.agentControllers,
        [agentId]: { abortController, baseAgentId, index, userRetryAttempt },
      },
    })
  })
}

export function recordWorkflowAgentProgress({
  taskId,
  agentId,
  tokenCount,
  toolUseCount,
  prompt,
  activity,
  setAppState,
}: {
  taskId: string
  agentId: string
  tokenCount: number
  toolUseCount: number
  prompt?: string
  activity?: string
  setAppState: SetAppState
}): void {
  withWorkflowTask(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    const current = task.liveAgents?.[agentId]
    return withProgressVersion({
      ...task,
      liveAgents: {
        ...task.liveAgents,
        [agentId]: {
          tokenCount: (current?.tokenCount ?? 0) + tokenCount,
          toolUseCount: (current?.toolUseCount ?? 0) + toolUseCount,
          ...(prompt ?? current?.prompt ? { prompt: prompt ?? current?.prompt } : {}),
          ...(activity ?? current?.activity ? { activity: activity ?? current?.activity } : {}),
          ...(activity
            ? { recentActivities: [...(current?.recentActivities ?? []), activity].slice(-MAX_RECENT_ACTIVITIES) }
            : current?.recentActivities ? { recentActivities: current.recentActivities } : {}),
        },
      },
    })
  })
}

function registeredAgentIdsForResult(
  task: LocalWorkflowTaskState,
  result: WorkflowAgentResult,
): string[] {
  const phase = task.phases.find(item => item.id === result.phaseId)
  const indexedAgentId = phase?.agentIds[result.index]
  return [result.agentId, indexedAgentId].filter(
    (agentId, index, agentIds): agentId is string => Boolean(agentId) && agentIds.indexOf(agentId) === index,
  )
}

function resultWithProgressMetrics(
  task: LocalWorkflowTaskState,
  registeredAgentIds: string[],
  result: WorkflowAgentResult,
): WorkflowAgentResult {
  const liveProgress = registeredAgentIds
    .map(agentId => task.liveAgents?.[agentId])
    .find(Boolean)
  if (!liveProgress) return result
  return {
    ...result,
    tokenCount: result.tokenCount ?? liveProgress.tokenCount,
    toolUseCount: result.toolUseCount ?? liveProgress.toolUseCount,
  }
}

function removeLiveAgentState(
  task: LocalWorkflowTaskState,
  agentIds: string[],
): Pick<LocalWorkflowTaskState, 'agentControllers' | 'liveAgents'> {
  const agentIdsToRemove = new Set(agentIds)
  return {
    liveAgents: Object.fromEntries(
      Object.entries(task.liveAgents ?? {}).filter(([agentId]) => !agentIdsToRemove.has(agentId)),
    ),
    agentControllers: Object.fromEntries(
      Object.entries(task.agentControllers ?? {}).filter(([agentId]) => !agentIdsToRemove.has(agentId)),
    ),
  }
}

function abortWorkflowControllers(task: LocalWorkflowTaskState, reason: string): void {
  task.abortController?.abort(reason)
  for (const controller of Object.values(task.agentControllers ?? {})) {
    controller.abortController.abort(reason)
  }
}

export function completeWorkflowAgent({
  taskId,
  result,
  setAppState,
}: {
  taskId: string
  result: WorkflowAgentResult
  setAppState: SetAppState
}): void {
  withWorkflowTask(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    const registeredAgentIds = registeredAgentIdsForResult(task, result)
    const completedResult = resultWithProgressMetrics(task, registeredAgentIds, result)
    const nextTask = updatePhase(task, completedResult.phaseId, phase => {
      const priorResultsForIndex = phase.results.filter(
        phaseResult => phaseResult.index === result.index,
      )
      const priorAgentIdsForIndex = [
        ...(completedResult.status === 'skipped' ? [phase.agentIds[result.index]] : []),
        result.agentId,
        ...priorResultsForIndex.map(phaseResult => phaseResult.agentId),
      ].filter(
        (agentId, index, agentIds): agentId is string => Boolean(agentId) && agentIds.indexOf(agentId) === index,
      )
      const nextPhase = {
        ...phase,
        completedAgentIds: addUnique(
          phase.completedAgentIds.filter(
            agentId => !priorAgentIdsForIndex.includes(agentId),
          ),
          completedResult.agentId,
        ),
        failedAgentIds: phase.failedAgentIds.filter(agentId => {
          if (priorAgentIdsForIndex.includes(agentId)) return false
          if (registeredAgentIds.includes(agentId)) return false
          if (registeredAgentIds.some(registeredAgentId => agentId.startsWith(`${registeredAgentId}-retry-`))) return false
          if (registeredAgentIds.some(registeredAgentId => registeredAgentId.startsWith(`${agentId}-retry-`))) return false
          if (agentId.startsWith(`${completedResult.agentId}-retry-`)) return false
          if (completedResult.agentId.startsWith(`${agentId}-retry-`)) return false
          return !agentId.includes(`-${completedResult.index + 1}-`)
        }),
        skippedAgentIds: completedResult.status === 'skipped'
          ? addUnique(
              phase.skippedAgentIds.filter(
                agentId => !priorAgentIdsForIndex.includes(agentId),
              ),
              completedResult.agentId,
            )
          : phase.skippedAgentIds.filter(
              agentId => !priorAgentIdsForIndex.includes(agentId),
            ),
        agentIds: completedResult.status === 'skipped' && phase.agentIds[completedResult.index]
          ? phase.agentIds
              .map((agentId, agentIndex) => agentIndex === completedResult.index ? completedResult.agentId : agentId)
              .filter((agentId, agentIndex, agentIds) => agentIds.indexOf(agentId) === agentIndex)
          : phase.agentIds,
        results: [...phase.results.filter(phaseResult => !priorAgentIdsForIndex.includes(phaseResult.agentId)), completedResult],
        error: undefined,
      }
      return {
        ...nextPhase,
        status: phaseCompleted(nextPhase) ? 'completed' : nextPhase.status,
      }
    })
    const liveState = removeLiveAgentState(nextTask, registeredAgentIds)
    const attemptState = updateWorkflowAgentAttempt(
      nextTask,
      registeredAgentIds.find(agentId => nextTask.agentAttempts?.some(attempt => attempt.agentId === agentId && attempt.status === 'running')) ?? completedResult.agentId,
      completedResult.status === 'skipped' ? 'skipped' : 'completed',
    )
    return {
      ...nextTask,
      ...liveState,
      ...attemptState,
      results: [
        ...nextTask.results.filter(
          taskResult => taskResult.phaseId !== completedResult.phaseId || taskResult.index !== completedResult.index,
        ),
        completedResult,
      ],
      summary: `Completed ${completedResult.phaseId} agent ${completedResult.index + 1}`,
      tokenCount: (nextTask.tokenCount ?? 0) + (completedResult.tokenCount ?? 0),
      toolUseCount: (nextTask.toolUseCount ?? 0) + (completedResult.toolUseCount ?? 0),
      error: undefined,
    }
  })
}

export function failWorkflowAgent({
  taskId,
  phaseId,
  agentId,
  index,
  error,
  errorKind,
  setAppState,
}: {
  taskId: string
  phaseId: string
  agentId: string
  index?: number
  error: string
  errorKind?: WorkflowAgentErrorKind
  setAppState: SetAppState
}): void {
  withWorkflowTask(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    const phase = task.phases.find(item => item.id === phaseId)
    const failedResult: WorkflowAgentResult = {
      phaseId,
      agentId,
      index: index ?? Math.max(phase?.agentIds.indexOf(agentId) ?? -1, 0),
      status: 'failed',
      error,
      errorKind,
    }
    const nextTask = updatePhase(
      { ...task, summary: `Workflow agent failed: ${error}` },
      phaseId,
      phase => ({
        ...phase,
        status: 'failed',
        failedAgentIds: addUnique(phase.failedAgentIds, agentId),
        results: [...removePhaseResultsForIndex(phase.results, failedResult.index), failedResult],
        error,
      }),
    )
    return {
      ...nextTask,
      ...removeLiveAgentState(nextTask, [agentId]),
      ...updateWorkflowAgentAttempt(nextTask, agentId, 'failed', error),
      results: [
        ...removeTaskResultsForPhaseIndex(
          nextTask.results,
          failedResult.phaseId,
          failedResult.index,
        ),
        failedResult,
      ],
    }
  })
}

export function completeWorkflowTask(
  taskId: string,
  setAppState: SetAppState,
): void {
  withWorkflowTask(taskId, setAppState, task => {
    if (terminalStatus(task.status)) return task
    return {
      ...task,
      status: 'completed',
      summary: 'Workflow completed',
      endTime: Date.now(),
      abortController: undefined,
      currentAgentId: undefined,
      agentControllers: undefined,
      liveAgents: undefined,
    }
  })
}

export function failWorkflowTask(
  taskId: string,
  error: string,
  setAppState: SetAppState,
): void {
  withWorkflowTask(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    abortWorkflowControllers(task, 'workflow-failed')
    return {
      ...task,
      status: 'failed',
      summary: `Workflow failed: ${error}`,
      error,
      endTime: Date.now(),
      abortController: undefined,
      currentAgentId: undefined,
      agentControllers: undefined,
      liveAgents: undefined,
    }
  })
}

function endWorkflowTask(
  taskId: string,
  status: LocalWorkflowTaskState['status'],
) {
  return (prev: AppState): AppState => {
    const task = prev.tasks?.[taskId]
    if (!task || task.type !== 'local_workflow') {
      return prev
    }

    if (terminalStatus(task.status)) {
      return prev
    }

    abortWorkflowControllers(task, `workflow-${status}`)
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: {
          ...task,
          status,
          summary: `Workflow ${status}`,
          endTime: Date.now(),
          abortController: undefined,
          currentAgentId: undefined,
          agentControllers: undefined,
          liveAgents: undefined,
        },
      },
    }
  }
}

export const LocalWorkflowTask: Task = {
  name: 'LocalWorkflowTask',
  type: 'local_workflow',
  async kill(taskId, setAppState) {
    setAppState(endWorkflowTask(taskId, 'killed'))
  },
}

export function pauseWorkflowTask(
  taskId: string,
  setAppState: SetAppState,
): void {
  withWorkflowTask(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    abortWorkflowControllers(task, 'workflow-paused')
    const pausedTask = {
      ...task,
      status: 'pending' as const,
      pausedAt: Date.now(),
      summary: `Workflow paused. ${buildResumePrompt(task)}`,
      abortController: undefined,
      currentAgentId: undefined,
      agentControllers: {},
      liveAgents: {},
    }
    return appendEvent(pausedTask, progressEvent(pausedTask, 'paused'))
  })
}

export function killWorkflowTask(
  taskId: string,
  setAppState: SetAppState,
): void {
  setAppState(endWorkflowTask(taskId, 'killed'))
}

export function skipWorkflowAgent(
  taskId: string,
  agentId: string,
  setAppState: SetAppState,
): void {
  withWorkflowTask(taskId, setAppState, task => {
    if (task.status !== 'running' || !workflowAgentIsControllable(task, agentId)) return task
    const skippedPhase = task.phases.find(phase => phase.agentIds.includes(agentId))
    const skippedController = task.agentControllers?.[agentId]
    const skippedIndex = skippedController?.index ?? skippedPhase?.agentIds.indexOf(agentId) ?? -1
    if (!skippedPhase || skippedIndex < 0) return task

    skippedController?.abortController.abort(WORKFLOW_AGENT_SKIPPED_ABORT_REASON)
    const { [agentId]: _skippedController, ...agentControllers } = task.agentControllers ?? {}
    const { [agentId]: _skippedLiveAgent, ...liveAgents } = task.liveAgents ?? {}
    const priorResultsForIndex = skippedPhase.results.filter(
      phaseResult => phaseResult.index === skippedIndex,
    )
    const priorAgentIdsForIndex = [
      skippedPhase.agentIds[skippedIndex],
      ...priorResultsForIndex.map(phaseResult => phaseResult.agentId),
    ].filter(
      (currentAgentId, index, agentIds): currentAgentId is string => Boolean(currentAgentId) && agentIds.indexOf(currentAgentId) === index,
    )
    const skippedResult = {
      phaseId: skippedPhase.id,
      agentId,
      index: skippedIndex,
      status: 'skipped' as const,
    }
    const skippedTask = {
      ...task,
      ...updateWorkflowAgentAttempt(task, agentId, 'skipped'),
      agentControllers,
      liveAgents,
      summary: `Workflow agent skipped by user: ${agentId}`,
      phases: task.phases.map(phase => {
        if (phase.id !== skippedPhase.id) return phase
        const nextPhase = {
          ...phase,
          failedAgentIds: phase.failedAgentIds.filter(
            currentAgentId => !priorAgentIdsForIndex.includes(currentAgentId) && currentAgentId !== agentId,
          ),
          skippedAgentIds: addUnique(
            phase.skippedAgentIds.filter(
              currentAgentId => !priorAgentIdsForIndex.includes(currentAgentId),
            ),
            agentId,
          ),
          completedAgentIds: addUnique(
            phase.completedAgentIds.filter(
              currentAgentId => !priorAgentIdsForIndex.includes(currentAgentId),
            ),
            agentId,
          ),
          agentIds: phase.agentIds[skippedIndex]
            ? phase.agentIds
                .map((currentAgentId, agentIndex) => agentIndex === skippedIndex ? agentId : currentAgentId)
                .filter((currentAgentId, agentIndex, agentIds) => agentIds.indexOf(currentAgentId) === agentIndex)
            : phase.agentIds,
          results: [...removePhaseResultsForIndex(phase.results, skippedIndex), skippedResult],
        }
        return {
          ...nextPhase,
          status: phaseCompleted(nextPhase) ? 'completed' as const : nextPhase.status,
          error: phaseCompleted(nextPhase) ? undefined : nextPhase.error,
        }
      }),
      results: [
        ...removeTaskResultsForPhaseIndex(task.results, skippedResult.phaseId, skippedResult.index),
        skippedResult,
      ],
    }
    return appendEvent(skippedTask, agentEvent(skippedTask, skippedPhase.id, agentId, 'skipped'))
  })
}

export function retryWorkflowAgent(
  taskId: string,
  agentId: string,
  setAppState: SetAppState,
): void {
  withWorkflowTask(taskId, setAppState, task => {
    if (task.status !== 'running' || !workflowAgentIsControllable(task, agentId)) return task
    let retryPhaseId: string | undefined
    let retryAgentId: string | undefined
    const controller = task.agentControllers?.[agentId]
    const baseAgentId = controller?.baseAgentId ?? agentId.replace(/ \(retry \d+\)$/u, '')
    const retryAttempt = (controller?.userRetryAttempt ?? 0) + 1
    const nextAgentId = `${baseAgentId} (retry ${retryAttempt})`
    controller?.abortController.abort(WORKFLOW_AGENT_USER_RETRY_ABORT_REASON)
    const { [agentId]: _retriedController, ...agentControllers } = task.agentControllers ?? {}
    const { [agentId]: _retriedLiveAgent, ...liveAgents } = task.liveAgents ?? {}
    const retryTask = {
      ...task,
      agentControllers,
      liveAgents,
      currentAgentId: nextAgentId,
      summary: `Workflow agent retry requested by user: ${agentId}`,
      agentAttempts: (task.agentAttempts ?? []).map(attempt =>
        attempt.agentId === agentId && attempt.status === 'running'
          ? { ...attempt, status: 'interrupted' as const, error: WORKFLOW_AGENT_USER_RETRY_ABORT_REASON }
          : attempt,
      ),
      phases: task.phases.map(phase => {
        if (!phase.agentIds.includes(agentId)) return phase
        retryPhaseId = phase.id
        retryAgentId = nextAgentId
        const agentIndex = phase.agentIds.indexOf(agentId)
        const agentIds = phase.agentIds.map(current => current === agentId ? nextAgentId : current)
        return {
          ...phase,
          status: 'running' as const,
          agentIds,
          completedAgentIds: removeValue(phase.completedAgentIds, agentId),
          skippedAgentIds: removeValue(phase.skippedAgentIds, agentId),
          failedAgentIds: removeValue(phase.failedAgentIds, agentId),
          results: [
            ...phase.results.filter(result => result.agentId !== agentId),
            { phaseId: phase.id, agentId: nextAgentId, index: agentIndex, status: 'running' as const },
          ],
          error: undefined,
        }
      }),
      results: task.results.filter(result => result.agentId !== agentId),
      error: undefined,
    }
    return retryPhaseId && retryAgentId
      ? appendEvent(retryTask, agentEvent(retryTask, retryPhaseId, retryAgentId, 'running'))
      : task
  })
}
