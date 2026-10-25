import type { UUID } from 'crypto'
import { randomBytes, randomUUID } from 'crypto'
import { getIsNonInteractiveSession, getSessionId } from '../bootstrap/state.js'
import type { SDKAssistantMessage, SDKUserMessage } from '../entrypoints/agentSdkTypes.js'
import type { SdkWorkflowProgress } from '../types/tools.js'

type TaskStartedEvent = {
  type: 'system'
  subtype: 'task_started'
  task_id: string
  run_id?: string
  tool_use_id?: string
  description: string
  subagent_type?: string
  is_backgrounded?: boolean
  spawn_depth?: number
  task_type?: string
  workflow_name?: string
  prompt?: string
}

// Changed fields of a task (status, description, end time, ...), as official sends them.
type TaskUpdatedEvent = {
  type: 'system'
  subtype: 'task_updated'
  task_id: string
  run_id?: string
  patch: {
    status?: string
    description?: string
    end_time?: number
    total_paused_ms?: number
    error?: string
    is_backgrounded?: boolean
  }
}

// The full list of background tasks, sent whenever it changes.
type BackgroundTasksChangedEvent = {
  type: 'system'
  subtype: 'background_tasks_changed'
  tasks: {
    task_id: string
    run_id?: string
    task_type: string
    subagent_type?: string
    description: string
  }[]
}

type TaskProgressEvent = {
  type: 'system'
  subtype: 'task_progress'
  task_id: string
  run_id?: string
  tool_use_id?: string
  description: string
  usage: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
  last_tool_name?: string
  summary?: string
  // Delta batch of workflow state changes. Clients upsert by
  // `${type}:${index}` then group by phaseIndex to rebuild the phase tree,
  // same fold as collectFromEvents + groupByPhase in PhaseProgress.tsx.
  workflow_progress?: SdkWorkflowProgress[]
}

// Emitted when a foreground agent completes without being backgrounded.
// Drained by drainSdkOutput() directly into the output stream — does NOT
// go through the print.ts XML task_notification parser and does NOT trigger
// the LLM loop. Consumers (e.g. VS Code session.ts) use this to remove the
// task from the subagent panel.
type TaskNotificationSdkEvent = {
  type: 'system'
  subtype: 'task_notification'
  task_id: string
  run_id?: string
  tool_use_id?: string
  status: 'completed' | 'failed' | 'stopped'
  output_file: string
  summary: string
  usage?: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
}

// Mirrors notifySessionStateChanged. The CCR bridge already receives this
// via its own listener; SDK consumers (scmuxd, VS Code) need the same signal
// to know when the main turn's generator is idle vs actively producing.
// The 'idle' transition fires AFTER heldBackResult flushes and the bg-agent
// do-while loop exits — so SDK consumers can trust it as the authoritative
// "turn is over" signal even when result was withheld for background agents.
type SessionStateChangedEvent = {
  type: 'system'
  subtype: 'session_state_changed'
  state: 'idle' | 'running' | 'requires_action'
}

export type SdkEvent =
  | TaskStartedEvent
  | TaskUpdatedEvent
  | BackgroundTasksChangedEvent
  | TaskProgressEvent
  | TaskNotificationSdkEvent
  | SessionStateChangedEvent

// A background agent's own messages, tagged with parent_tool_use_id. They share
// the queue so they stay in order with that agent's task events.
type SubagentSdkMessage = SDKAssistantMessage | SDKUserMessage

// Id of one run of a task, as official sends it on every task_* event: a resumed
// task keeps its task_id and gets a new run id. Run ids of one task sort in the
// order the runs opened.
const runIds = new Map<string, string>()

export function startTaskRun(taskId: string): void {
  const previous = runIds.get(taskId)
  const previousTime = previous ? parseInt(previous.split('-')[0]!, 36) : -1
  const time = Math.max(Date.now(), previousTime + 1).toString(36).padStart(9, '0')
  runIds.set(taskId, `${time}-${randomBytes(4).toString('hex')}`)
}

export function getTaskRunId(taskId: string): string | undefined {
  return runIds.get(taskId)
}

const MAX_QUEUE_SIZE = 1000
const queue: (SdkEvent | SubagentSdkMessage)[] = []

export function enqueueSdkEvent(event: SdkEvent | SubagentSdkMessage): void {
  // SDK events are only consumed (drained) in headless/streaming mode.
  // In TUI mode they would accumulate up to the cap and never be read.
  if (!getIsNonInteractiveSession()) {
    return
  }
  if (queue.length >= MAX_QUEUE_SIZE) {
    queue.shift()
  }
  if (event.type === 'system' && 'task_id' in event && runIds.has(event.task_id)) {
    event = { ...event, run_id: runIds.get(event.task_id) }
  }
  queue.push(event)
}

/** Everything queued for the SDK output stream, in order. */
export function drainSdkOutput(): Array<
  (SdkEvent & { uuid: UUID; session_id: string }) | SubagentSdkMessage
> {
  if (queue.length === 0) {
    return []
  }
  return queue.splice(0).map(e =>
    e.type === 'system'
      ? { ...e, uuid: randomUUID(), session_id: getSessionId() }
      : e,
  )
}

/** The queued system events; subagent messages are dropped. */
export function drainSdkEvents(): Array<
  SdkEvent & { uuid: UUID; session_id: string }
> {
  return drainSdkOutput().filter(
    (e): e is SdkEvent & { uuid: UUID; session_id: string } =>
      e.type === 'system',
  )
}

/**
 * Emit a task_notification SDK event for a task reaching a terminal state.
 *
 * registerTask() always emits task_started; this is the closing bookend.
 * Call this from any exit path that sets a task terminal WITHOUT going
 * through enqueuePendingNotification-with-<task-id> (print.ts parses that
 * XML into the same SDK event, so paths that do both would double-emit).
 * Paths that suppress the XML notification (notified:true pre-set, kill
 * paths, abort branches) must call this directly so SDK consumers
 * (Scuttle's bg-task dot, VS Code subagent panel) see the task close.
 */
export function emitTaskTerminatedSdk(
  taskId: string,
  status: 'completed' | 'failed' | 'stopped',
  opts?: {
    toolUseId?: string
    summary?: string
    outputFile?: string
    usage?: { total_tokens: number; tool_uses: number; duration_ms: number }
  },
): void {
  enqueueSdkEvent({
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    tool_use_id: opts?.toolUseId,
    status,
    output_file: opts?.outputFile ?? '',
    summary: opts?.summary ?? '',
    usage: opts?.usage,
  })
}
