import { randomBytes } from 'node:crypto'
import type { AppState } from '../../state/AppState.js'
import type { SetAppState, Task, TaskStateBase } from '../../Task.js'
import type {
  WorkflowArgs,
  WorkflowDryRunPhase,
  WorkflowDryRunPlan,
  WorkflowProgressEvent,
  WorkflowRuntimeSpec,
} from '../../tools/WorkflowTool/workflowSpec.js'

const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

function generateWorkflowTaskId(): string {
  const bytes = randomBytes(8)
  let id = 'w'
  for (let i = 0; i < 8; i++) {
    id += TASK_ID_ALPHABET[bytes[i]! % TASK_ID_ALPHABET.length]
  }
  return id
}

function workflowOutputPath(taskId: string): string {
  return `.claude/tasks/${taskId}.output`
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
    outputFile: workflowOutputPath(id),
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

export type WorkflowAgentResult = {
  phaseId: string
  agentId: string
  index: number
  status: 'completed' | 'failed' | 'skipped'
  output?: string
  error?: string
  tokenCount?: number
  toolUseCount?: number
  durationMs?: number
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

export type LocalWorkflowTaskState = TaskStateBase & {
  type: 'local_workflow'
  currentAgentId?: string
  workflowName?: string
  workflowRunId?: string
  scriptPath?: string
  runArgs?: WorkflowArgs
  summary?: string
  agentCount?: number
  tokenCount?: number
  toolUseCount?: number
  execution?: 'agent' | 'team'
  teamName?: string
  runtime?: WorkflowRuntimeSpec
  sourcePath?: string
  runScriptSnapshot?: string
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
}: {
  plan: WorkflowDryRunPlan
  setAppState: SetAppState
  toolUseId?: string
  runArgs?: WorkflowArgs
  teamName?: string
  workflowRunId?: string
  scriptPath?: string
}): LocalWorkflowTaskState {
  const id = generateWorkflowTaskId()
  const taskState: LocalWorkflowTaskState = {
    ...createWorkflowTaskBase(id, `Workflow: ${plan.name}`, toolUseId),
    type: 'local_workflow',
    status: 'running',
    workflowName: plan.name,
    workflowRunId,
    scriptPath,
    runArgs,
    summary: 'Workflow started',
    agentCount: plan.totalAgents,
    tokenCount: 0,
    toolUseCount: 0,
    execution: plan.defaults.execution,
    teamName,
    runtime: plan.runtime,
    sourcePath: plan.sourcePath,
    runScriptSnapshot: plan.runScriptSnapshot,
    abortController: new AbortController(),
    phases: plan.phases.map(createPhaseState),
    results: [],
    events: [],
  }

  registerWorkflowTaskState(taskState, setAppState)
  return taskState
}

function registerWorkflowTaskState(
  task: LocalWorkflowTaskState,
  setAppState: SetAppState,
): void {
  setAppState(prev => ({
    ...prev,
    tasks: {
      ...prev.tasks,
      [task.id]: task,
    },
  }))
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

function updatePhase(
  task: LocalWorkflowTaskState,
  phaseId: string,
  updater: (phase: LocalWorkflowPhaseState) => LocalWorkflowPhaseState,
): LocalWorkflowTaskState {
  return {
    ...task,
    phases: task.phases.map(phase =>
      phase.id === phaseId ? updater(phase) : phase,
    ),
  }
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

export function recordWorkflowEvent({
  taskId,
  event,
  setAppState,
}: {
  taskId: string
  event: WorkflowProgressEvent
  setAppState: SetAppState
}): void {
  withWorkflowTask(taskId, setAppState, task => ({
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
    return updatePhase(
      { ...task, currentAgentId: agentId },
      phaseId,
      phase => ({
        ...phase,
        status: 'running',
        agentIds: addUnique(phase.agentIds, agentId),
      }),
    )
  })
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
    const nextTask = updatePhase(task, result.phaseId, phase => {
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
          result.agentId,
        ),
        failedAgentIds: phase.failedAgentIds.filter(agentId => {
          if (priorAgentIdsForIndex.includes(agentId)) return false
          return !agentId.includes(`-${result.index + 1}-`)
        }),
        skippedAgentIds: phase.skippedAgentIds.filter(
          agentId => !priorAgentIdsForIndex.includes(agentId),
        ),
        results: [...removePhaseResultsForIndex(phase.results, result.index), result],
        error: undefined,
      }
      return {
        ...nextPhase,
        status: phaseCompleted(nextPhase) ? 'completed' : nextPhase.status,
      }
    })
    return {
      ...nextTask,
      results: [
        ...removeTaskResultsForPhaseIndex(
          nextTask.results,
          result.phaseId,
          result.index,
        ),
        result,
      ],
      summary: `Completed ${result.phaseId} agent ${result.index + 1}`,
      tokenCount: (nextTask.tokenCount ?? 0) + (result.tokenCount ?? 0),
      toolUseCount: (nextTask.toolUseCount ?? 0) + (result.toolUseCount ?? 0),
      error: undefined,
    }
  })
}

export function failWorkflowAgent({
  taskId,
  phaseId,
  agentId,
  error,
  setAppState,
}: {
  taskId: string
  phaseId: string
  agentId: string
  error: string
  setAppState: SetAppState
}): void {
  withWorkflowTask(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    return updatePhase(
      { ...task, summary: `Workflow agent failed: ${error}` },
      phaseId,
      phase => ({
        ...phase,
        status: 'failed',
        failedAgentIds: addUnique(phase.failedAgentIds, agentId),
        error,
      }),
    )
  })
}

export function completeWorkflowTask(
  taskId: string,
  setAppState: SetAppState,
): void {
  withWorkflowTask(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    return {
      ...task,
      status: 'completed',
      summary: 'Workflow completed',
      endTime: Date.now(),
      abortController: undefined,
      currentAgentId: undefined,
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
    task.abortController?.abort()
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

    task.abortController?.abort()
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
    return {
      ...task,
      status: 'pending',
      pausedAt: Date.now(),
      summary: 'Workflow paused',
    }
  })
}

export function resumeWorkflowTask(
  taskId: string,
  setAppState: SetAppState,
): void {
  withWorkflowTask(taskId, setAppState, task => {
    if (task.status !== 'pending') return task
    const pausedMs = task.pausedAt ? Date.now() - task.pausedAt : 0
    return {
      ...task,
      status: 'running',
      totalPausedMs: (task.totalPausedMs ?? 0) + Math.max(0, pausedMs),
      pausedAt: undefined,
      summary: 'Workflow resumed',
    }
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
    return {
      ...task,
      phases: task.phases.map(phase => {
        if (!phase.agentIds.includes(agentId)) return phase
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
          status: phaseCompleted(nextPhase) ? 'completed' : nextPhase.status,
        }
      }),
    }
  })
}

export function retryWorkflowAgent(
  taskId: string,
  agentId: string,
  setAppState: SetAppState,
): void {
  withWorkflowTask(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    return {
      ...task,
      phases: task.phases.map(phase => {
        if (!phase.agentIds.includes(agentId)) return phase
        const agentIds = removeValue(phase.agentIds, agentId)
        return {
          ...phase,
          status: agentIds.length === 0 ? 'pending' : 'running',
          agentIds,
          completedAgentIds: removeValue(phase.completedAgentIds, agentId),
          skippedAgentIds: removeValue(phase.skippedAgentIds, agentId),
          failedAgentIds: removeValue(phase.failedAgentIds, agentId),
          results: phase.results.filter(result => result.agentId !== agentId),
          error: undefined,
        }
      }),
      results: task.results.filter(result => result.agentId !== agentId),
      error: undefined,
    }
  })
}
