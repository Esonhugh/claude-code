import type { WorkflowAgentErrorKind } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'

type WorkflowRetryDebugInput = {
  event: string
  taskId: string
  workflowRunId: string
  phaseId: string
  logicalAgentId: string
  agentId: string
  attempt: number
  workerIndex?: number
  errorKind?: WorkflowAgentErrorKind
  retryable?: boolean
  status?: string
  detail?: string
}

export function workflowRetryDebugMessage(
  input: WorkflowRetryDebugInput,
): string {
  const parts = [
    input.event,
    `task=${input.taskId}`,
    `run=${input.workflowRunId}`,
    `phase=${input.phaseId}`,
    `logical=${input.logicalAgentId}`,
    `agent=${input.agentId}`,
    `attempt=${input.attempt}`,
  ]
  if (input.workerIndex !== undefined) parts.push(`worker=${input.workerIndex}`)
  if (input.errorKind) parts.push(`kind=${input.errorKind}`)
  if (input.retryable !== undefined) parts.push(`retryable=${input.retryable}`)
  if (input.status) parts.push(`status=${input.status}`)
  if (input.detail) parts.push(`detail=${input.detail}`)
  return parts.join(' ')
}
