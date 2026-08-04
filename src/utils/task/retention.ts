import type { TaskType } from '../../Task.js'
import { isTerminalTaskStatus, type TaskStatus } from '../../taskStatus.js'

export type RetainableTaskState = {
  status: TaskStatus
  notified: boolean
  type: TaskType
  retain?: unknown
  evictAfter?: number
  viewingAgentTaskId?: string
  id?: string
}

export function canEvictTerminalTask(task: RetainableTaskState, now = Date.now()): boolean {
  if (!isTerminalTaskStatus(task.status)) return false
  if (!task.notified) return false
  if (task.type === 'local_workflow') return false
  if (task.viewingAgentTaskId && task.id && task.viewingAgentTaskId === task.id) {
    return false
  }
  if (task.retain !== undefined && (task.evictAfter ?? Infinity) > now) return false
  return true
}
