import isEqual from 'lodash-es/isEqual.js'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { AppState } from '../state/AppStateStore.js'

type RemoteTasks = AppState['remoteTasks']

/**
 * Control requests the local UI of `claude ssh` / Direct Connect sends to the
 * headless child for one of its tasks. Set by the session hook while it is
 * connected; the /tasks dialog reads it.
 */
export type RemoteTaskControl = {
  sendTaskMessage(taskId: string, text: string): Promise<string>
  stopTask(taskId: string): Promise<void>
  getTaskOutput(taskId: string): Promise<string>
}

let current: RemoteTaskControl | null = null

export function setRemoteTaskControl(control: RemoteTaskControl | null): void {
  current = control
}

export function getRemoteTaskControl(): RemoteTaskControl | null {
  return current
}

/** Builds a RemoteTaskControl on top of a manager's generic control request. */
export function createRemoteTaskControl(
  request: (body: Record<string, unknown>) => Promise<Record<string, unknown>>,
): RemoteTaskControl {
  return {
    async sendTaskMessage(taskId, text) {
      const response = await request({ subtype: 'send_task_message', task_id: taskId, text })
      return typeof response.delivery === 'string' ? response.delivery : 'sent'
    },
    async stopTask(taskId) {
      await request({ subtype: 'stop_task', task_id: taskId })
    },
    async getTaskOutput(taskId) {
      const response = await request({ subtype: 'get_task_output', task_id: taskId })
      return typeof response.output === 'string' ? response.output : ''
    },
  }
}

/**
 * Folds a child's task_started / task_progress / task_notification event into
 * the local projection. Returns the same object when nothing changed.
 */
export function applyRemoteTaskEvent(tasks: RemoteTasks, sdkMessage: SDKMessage): RemoteTasks {
  if (sdkMessage.type !== 'system') return tasks
  if (sdkMessage.subtype === 'task_started') {
    const current = tasks[sdkMessage.task_id]
    if (
      current &&
      current.toolUseId === sdkMessage.tool_use_id &&
      current.taskType === sdkMessage.task_type &&
      current.description === sdkMessage.description &&
      current.workflowName === sdkMessage.workflow_name &&
      current.prompt === sdkMessage.prompt
    ) {
      return tasks
    }
    return {
      ...tasks,
      [sdkMessage.task_id]: {
        taskId: sdkMessage.task_id,
        toolUseId: sdkMessage.tool_use_id,
        taskType: sdkMessage.task_type,
        description: sdkMessage.description,
        workflowName: sdkMessage.workflow_name,
        prompt: sdkMessage.prompt,
      },
    }
  }
  if (sdkMessage.subtype === 'task_notification') {
    if (!tasks[sdkMessage.task_id]) return tasks
    const next = { ...tasks }
    delete next[sdkMessage.task_id]
    return next
  }
  if (sdkMessage.subtype === 'task_progress') {
    const current = tasks[sdkMessage.task_id]
    if (!current) return tasks
    const next = {
      ...current,
      description: sdkMessage.description,
      usage: {
        totalTokens: sdkMessage.usage.total_tokens,
        toolUses: sdkMessage.usage.tool_uses,
        durationMs: sdkMessage.usage.duration_ms,
      },
      lastToolName: sdkMessage.last_tool_name,
      summary: sdkMessage.summary,
      workflowProgress: sdkMessage.workflow_progress,
    }
    return isEqual(current, next) ? tasks : { ...tasks, [sdkMessage.task_id]: next }
  }
  return tasks
}
