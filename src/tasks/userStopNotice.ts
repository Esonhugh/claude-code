// The notice the model gets once the user stops its background work (official
// 2.1.329 `_bn` and the stop sweep). It never starts a turn: the next turn's
// first request takes it, after that turn's prompt.

import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TOOL_USE_ID_TAG,
} from '../constants/xml.js'
import { enqueuePendingNotification } from '../utils/messageQueueManager.js'
import { escapeXml } from '../utils/xml.js'
import type { LocalAgentTaskState } from './LocalAgentTask/LocalAgentTask.js'
import type { LocalWorkflowTaskState } from './LocalWorkflowTask/LocalWorkflowTask.js'

/** Who stopped it: the user at this terminal, or the user or the SDK host. */
export type UserStopSource = 'user' | 'client' | 'service'

const STOPPED_BY: Record<UserStopSource, string> = {
  user: ' by the user',
  client: ' by the user or by the app connected to this session',
  service: '',
}

const NO_RESULT = 'It is no longer running and no result will follow.'
const NO_RESULT_DO_NOT_RESTART = `${NO_RESULT} Do not start it again unless the user asks.`
const WORKFLOW_NO_RESULT = 'No result will follow unless the user has it resumed.'

export function enqueueUserStopNotice({
  taskId,
  toolUseId,
  description,
  source,
  outputFile,
  note,
  body = '',
}: {
  taskId: string
  toolUseId?: string
  description: string
  source: UserStopSource
  outputFile?: string
  note?: string
  body?: string
}): void {
  const stopped = `Task "${description}" was stopped${STOPPED_BY[source]}`
  const summary = note === undefined ? stopped : `${stopped}. ${note}`
  const toolUseIdLine = toolUseId ? `\n<${TOOL_USE_ID_TAG}>${escapeXml(toolUseId)}</${TOOL_USE_ID_TAG}>` : ''
  const outputFileLine = outputFile ? `\n<${OUTPUT_FILE_TAG}>${outputFile}</${OUTPUT_FILE_TAG}>` : ''
  void enqueuePendingNotification({
    value: `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${escapeXml(taskId)}</${TASK_ID_TAG}>${toolUseIdLine}${outputFileLine}
<${STATUS_TAG}>killed</${STATUS_TAG}>
<${SUMMARY_TAG}>${escapeXml(summary)}</${SUMMARY_TAG}>${body}
</${TASK_NOTIFICATION_TAG}>`,
    mode: 'task-notification',
    skipAttachments: true,
    priority: 'next',
    passive: true,
    taskId,
    // The stop already closed the task for SDK consumers.
    sdkTaskNotificationSent: true,
  })
}

/** Official `GWr`: how to resume a stopped workflow, when its script and run are known. */
export function workflowRecoveryBody(task: LocalWorkflowTaskState): string {
  if (task.scriptPath === undefined || task.workflowRunId === undefined) return ''
  const args = task.runArgs !== undefined ? `, args: ${JSON.stringify(task.runArgs)}` : ''
  const call = `Workflow({scriptPath: '${task.scriptPath}', resumeFromRunId: '${task.workflowRunId}'${args}})`
  return `\n<recovery>${escapeXml(`Its finished agent calls are saved. Only if the user asks you to resume it, call: ${call}`)}</recovery>`
}

/** Official stop sweep: one notice per background agent and workflow a stop ended. */
export function enqueueStopSweepNotices(
  stopped: readonly (LocalAgentTaskState | LocalWorkflowTaskState)[],
  source: UserStopSource,
): void {
  for (const task of stopped) {
    if (task.type === 'local_workflow') {
      if (task.toolUseId === undefined) continue
      enqueueUserStopNotice({
        taskId: task.id,
        toolUseId: task.toolUseId,
        description: task.description,
        source,
        note: WORKFLOW_NO_RESULT,
        body: workflowRecoveryBody(task),
      })
      continue
    }
    enqueueUserStopNotice({
      taskId: task.id,
      toolUseId: task.toolUseId,
      description: task.description,
      source,
      note: source === 'client' ? NO_RESULT_DO_NOT_RESTART : NO_RESULT,
    })
  }
}
