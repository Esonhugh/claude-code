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
}: {
  plan: WorkflowDryRunPlan
  setAppState: SetAppState
  toolUseId?: string
  runArgs?: WorkflowArgs
  teamName?: string
  workflowRunId?: string
  scriptPath?: string
  defaultModel?: string
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
    agentCount: plan.totalAgents,
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

function phaseCompleted(phase: LocalWorkflowPhaseState): boolean {
  return (
    phase.agentIds.length > 0 &&
    phase.completedAgentIds.length >= phase.agentIds.length &&
    phase.failedAgentIds.length === 0
  )
}

function completedAgents(task: LocalWorkflowTaskState): number {
  return task.phases.reduce(
    (sum, phase) => sum + phase.completedAgentIds.length,
    0,
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
    completedAgents: completedAgents(task),
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
}: {
  taskId: string
  phaseId: string
  agentId: string
  setAppState: SetAppState
}): void {
  withWorkflowTask(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    const updated = updatePhase(
      { ...task, currentAgentId: agentId },
      phaseId,
      phase => ({
        ...phase,
        status: 'running',
        agentIds: addUnique(phase.agentIds, agentId),
      }),
    )
    // Register a liveAgents entry so the agent shows as 'running' in UI
    return {
      ...updated,
      liveAgents: {
        ...updated.liveAgents,
        [agentId]: updated.liveAgents?.[agentId] ?? { tokenCount: 0, toolUseCount: 0 },
      },
    }
  })
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
      const priorAgentIdsForIndex = priorResultsForIndex.map(
        phaseResult => phaseResult.agentId,
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
        skippedAgentIds: phase.skippedAgentIds.filter(
          agentId => !priorAgentIdsForIndex.includes(agentId),
        ),
        results: [...removePhaseResultsForIndex(phase.results, completedResult.index), completedResult],
        error: undefined,
      }
      return {
        ...nextPhase,
        status: phaseCompleted(nextPhase) ? 'completed' : nextPhase.status,
      }
    })
    const liveState = removeLiveAgentState(nextTask, registeredAgentIds)
    return {
      ...nextTask,
      ...liveState,
      results: [
        ...removeTaskResultsForPhaseIndex(
          nextTask.results,
          completedResult.phaseId,
          completedResult.index,
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
  error,
  errorKind,
  setAppState,
}: {
  taskId: string
  phaseId: string
  agentId: string
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
      index: Math.max(phase?.agentIds.indexOf(agentId) ?? -1, 0),
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
    if (task.status !== 'running') return task
    let skippedPhaseId: string | undefined
    task.agentControllers?.[agentId]?.abortController.abort(WORKFLOW_AGENT_SKIPPED_ABORT_REASON)
    const { [agentId]: _skippedController, ...agentControllers } = task.agentControllers ?? {}
    const { [agentId]: _skippedLiveAgent, ...liveAgents } = task.liveAgents ?? {}
    const skippedTask = {
      ...task,
      agentControllers,
      liveAgents,
      summary: `Workflow agent skipped by user: ${agentId}`,
      phases: task.phases.map(phase => {
        if (!phase.agentIds.includes(agentId)) return phase
        skippedPhaseId = phase.id
        const nextPhase = {
          ...phase,
          skippedAgentIds: addUnique(phase.skippedAgentIds, agentId),
          completedAgentIds: addUnique(phase.completedAgentIds, agentId),
          results: [
            ...phase.results,
            { phaseId: phase.id, agentId, index: phase.agentIds.indexOf(agentId), status: 'skipped' as const },
          ],
        }
        return {
          ...nextPhase,
          status: phaseCompleted(nextPhase) ? 'completed' as const : nextPhase.status,
        }
      }),
    }
    const skippedIndex = skippedPhaseId
      ? task.phases.find(phase => phase.id === skippedPhaseId)?.agentIds.indexOf(agentId) ?? -1
      : -1
    const skippedResult = skippedPhaseId && skippedIndex >= 0
      ? { phaseId: skippedPhaseId, agentId, index: skippedIndex, status: 'skipped' as const }
      : undefined
    const skippedTaskWithResult = skippedResult
      ? {
          ...skippedTask,
          results: [
            ...removeTaskResultsForPhaseIndex(skippedTask.results, skippedResult.phaseId, skippedResult.index),
            skippedResult,
          ],
        }
      : skippedTask
    return skippedPhaseId
      ? appendEvent(skippedTaskWithResult, agentEvent(skippedTaskWithResult, skippedPhaseId, agentId, 'skipped'))
      : task
  })
}

export function retryWorkflowAgent(
  taskId: string,
  agentId: string,
  setAppState: SetAppState,
): void {
  withWorkflowTask(taskId, setAppState, task => {
    if (task.status !== 'running') return task
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
