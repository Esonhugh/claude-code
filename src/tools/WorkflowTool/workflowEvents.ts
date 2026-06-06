import type { WorkflowProgressEvent } from './workflowSpec.js'

export const WORKFLOW_EVENT_TYPES = [
  'workflow_progress',
  'workflow_phase',
  'workflow_agent',
  'workflow_log',
] as const

export function createWorkflowProgressEvent(input: {
  workflowRunId: string
  status: 'running' | 'paused' | 'completed' | 'failed' | 'killed'
  completedAgents: number
  totalAgents: number
  timestamp?: number
}): WorkflowProgressEvent {
  return {
    type: 'workflow_progress',
    workflowRunId: input.workflowRunId,
    status: input.status,
    completedAgents: input.completedAgents,
    totalAgents: input.totalAgents,
    timestamp: input.timestamp ?? Date.now(),
  }
}

export function createWorkflowPhaseEvent(input: {
  workflowRunId: string
  phaseId: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  timestamp?: number
}): WorkflowProgressEvent {
  return {
    type: 'workflow_phase',
    workflowRunId: input.workflowRunId,
    phaseId: input.phaseId,
    status: input.status,
    timestamp: input.timestamp ?? Date.now(),
  }
}

export function createWorkflowAgentEvent(input: {
  workflowRunId: string
  phaseId: string
  agentId: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  cacheHit?: boolean
  timestamp?: number
}): WorkflowProgressEvent {
  return {
    type: 'workflow_agent',
    workflowRunId: input.workflowRunId,
    phaseId: input.phaseId,
    agentId: input.agentId,
    status: input.status,
    ...(input.cacheHit !== undefined ? { cacheHit: input.cacheHit } : {}),
    timestamp: input.timestamp ?? Date.now(),
  }
}

export function createWorkflowLogEvent(input: {
  workflowRunId: string
  message: string
  timestamp?: number
}): WorkflowProgressEvent {
  return {
    type: 'workflow_log',
    workflowRunId: input.workflowRunId,
    message: input.message,
    timestamp: input.timestamp ?? Date.now(),
  }
}
