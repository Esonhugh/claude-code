import stripAnsi from 'strip-ansi'
import { wrapAnsi } from '../../ink/wrapAnsi.js'
import type {
  LocalWorkflowPhaseState,
  LocalWorkflowTaskState,
  WorkflowAgentResult,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'

export type WorkflowDetailAgentStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped' | 'interrupted'

export function workflowDetailStatusWord(status: LocalWorkflowTaskState['status']): string {
  if (status === 'completed') return 'done'
  if (status === 'failed') return 'failed'
  if (status === 'pending') return 'paused'
  if (status === 'killed') return 'killed'
  return 'running'
}

function normalizeWorkflowDetailText(text: string): string {
  return stripAnsi(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\t\v\f]/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
}

export function wrapWorkflowDetailText(text: string, width: number): string[] {
  if (width <= 0) return []
  return normalizeWorkflowDetailText(text).split('\n').flatMap(line => {
    const wrapped = wrapAnsi(line, width, { hard: true, trim: false }).split('\n')
    return wrapped.length > 0 ? wrapped : ['']
  })
}

function isRuntimeVisiblePhase(phase: LocalWorkflowPhaseState): boolean {
  return phase.agentIds.length > 0 || phase.status === 'running'
}

function emptyMetaPhase(id: string): LocalWorkflowPhaseState {
  return {
    id,
    status: 'pending',
    agentIds: [],
    completedAgentIds: [],
    skippedAgentIds: [],
    failedAgentIds: [],
    results: [],
  }
}

export function visibleWorkflowPhases(task: LocalWorkflowTaskState): LocalWorkflowPhaseState[] {
  const metaPhases = task.meta?.phases ?? []
  if (metaPhases.length === 0) {
    return task.phases.filter(isRuntimeVisiblePhase)
  }

  const visible: LocalWorkflowPhaseState[] = []
  const used = new Set<LocalWorkflowPhaseState>()

  for (let index = 0; index < metaPhases.length; index += 1) {
    const metaPhase = metaPhases[index]!
    const matchingPhase = task.phases.find(phase => phase.id === metaPhase.title && !used.has(phase))
      ?? (task.phases[index] && !used.has(task.phases[index]!) ? task.phases[index] : undefined)

    if (matchingPhase) {
      visible.push(matchingPhase)
      used.add(matchingPhase)
    } else {
      visible.push(emptyMetaPhase(metaPhase.title))
    }
  }

  for (const phase of task.phases) {
    if (!used.has(phase) && isRuntimeVisiblePhase(phase)) {
      visible.push(phase)
    }
  }

  return visible
}

export function workflowDetailPhaseName(
  task: LocalWorkflowTaskState,
  phase: LocalWorkflowPhaseState | undefined,
  visiblePhaseIndex: number,
): string {
  return task.meta?.phases?.[visiblePhaseIndex]?.title ?? phase?.id ?? ''
}

export function workflowDetailAgentPhase(
  task: LocalWorkflowTaskState,
  agentId: string,
): LocalWorkflowPhaseState | undefined {
  return task.phases.find(phase => phase.agentIds.includes(agentId))
}

export function workflowDetailAgentResult(
  task: LocalWorkflowTaskState,
  agentId: string,
): WorkflowAgentResult | undefined {
  const direct = task.results.find(result => result.agentId === agentId) ??
    task.phases.flatMap(phase => phase.results).find(result => result.agentId === agentId)
  if (direct) return direct

  const phase = workflowDetailAgentPhase(task, agentId)
  const index = phase?.agentIds.indexOf(agentId) ?? -1
  if (!phase || index < 0) return undefined
  return phase.results.find(result => result.index === index) ??
    task.results.find(result => result.phaseId === phase.id && result.index === index)
}

export function workflowDetailAgentStatus(
  task: LocalWorkflowTaskState,
  agentId: string,
): WorkflowDetailAgentStatus {
  const phase = workflowDetailAgentPhase(task, agentId)
  if (phase?.completedAgentIds.includes(agentId)) {
    const result = workflowDetailAgentResult(task, agentId)
    if (result?.status === 'failed') return 'failed'
    if (result?.status === 'skipped') return 'skipped'
    return 'done'
  }
  if (phase) {
    const index = phase.agentIds.indexOf(agentId)
    if (index >= 0) {
      const resultAtIndex = phase.results.find(result => result.index === index)
      if (resultAtIndex) {
        if (resultAtIndex.status === 'failed') return 'failed'
        if (resultAtIndex.status === 'skipped') return 'skipped'
        return 'done'
      }
    }
  }
  if (task.liveAgents?.[agentId]) return 'running'
  if (task.status === 'pending' || task.status === 'killed') return 'interrupted'
  if (task.status === 'completed' || task.status === 'failed') {
    const result = workflowDetailAgentResult(task, agentId)
    if (result) return result.status === 'failed' ? 'failed' : result.status === 'skipped' ? 'skipped' : 'done'
    return task.status === 'completed' ? 'done' : 'interrupted'
  }
  return 'queued'
}

export function workflowDetailAgentMetrics(
  task: LocalWorkflowTaskState,
  agentId: string,
): { tokens: number; toolCalls: number; durationMs: number } {
  const result = workflowDetailAgentResult(task, agentId)
  const live = task.liveAgents?.[agentId]
  return {
    tokens: live?.tokenCount ?? result?.tokenCount ?? 0,
    toolCalls: live?.toolUseCount ?? result?.toolUseCount ?? 0,
    durationMs: result?.durationMs ?? 0,
  }
}

export function workflowDetailAgentPrompt(
  task: LocalWorkflowTaskState,
  agentId: string,
): string {
  const phases = visibleWorkflowPhases(task)
  const phase = workflowDetailAgentPhase(task, agentId)
  const phaseIndex = phase ? phases.indexOf(phase) : -1
  const result = workflowDetailAgentResult(task, agentId)
  return task.liveAgents?.[agentId]?.prompt ??
    result?.prompt ??
    (phaseIndex >= 0 ? task.meta?.phases?.[phaseIndex]?.detail : undefined) ??
    phase?.id ??
    agentId
}

export function workflowDetailAgentOutcome(
  task: LocalWorkflowTaskState,
  agentId: string,
): string {
  const status = workflowDetailAgentStatus(task, agentId)
  if (status === 'queued') return 'Waiting for an agent slot.'
  if (status === 'running') return 'Still running…'
  if (status === 'interrupted') return 'The workflow stopped before this agent finished.'
  if (status === 'skipped') return 'Skipped by user.'
  if (status === 'failed') return workflowDetailAgentResult(task, agentId)?.error ?? 'failed'
  return workflowDetailAgentResult(task, agentId)?.output ?? '(empty)'
}
