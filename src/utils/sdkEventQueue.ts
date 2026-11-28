import type { UUID } from 'crypto'
import { randomBytes, randomUUID } from 'crypto'
import { getIsNonInteractiveSession, getSessionId } from '../bootstrap/state.js'
import type { SDKAssistantMessage, SDKConversationResetMessage, SDKUserMessage } from '../entrypoints/agentSdkTypes.js'
import type { SdkWorkflowProgress } from '../types/tools.js'
import type { SubagentHandbackOutcome } from './subagentHandback.js'

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
  parent_task_id?: string
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
    is_idle?: boolean
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
  subagent_type?: string
  usage: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
  last_tool_name?: string
  summary?: string
  // Every agent and phase row of the workflow so far, as official 2.1.329
  // sends it; left out when only agent activity changed since the last one.
  workflow_progress?: SdkWorkflowProgress[]
}

// Emitted when a foreground agent completes without being backgrounded.
// Drained by drainSdkOutput() directly into the output stream — does NOT
// go through the print.ts XML task_notification parser and does NOT trigger
// the LLM loop. Consumers (e.g. VS Code session.ts) use this to remove the
// task from the subagent panel.
/** A hand-back's delivered report as SDK hosts render it, its warning above its text; toolUseId is the SubagentHandback call that sent it. */
export type SdkHandbackReport = { text: string; warning?: string; toolUseId?: string }

type TaskNotificationSdkEvent = {
  type: 'system'
  subtype: 'task_notification'
  task_id: string
  run_id?: string
  tool_use_id?: string
  parent_task_id?: string | null
  /** An owned task explicitly delivered its report to the main thread. */
  notification_to_main?: true
  status: 'completed' | 'failed' | 'stopped'
  output_file: string
  summary: string
  summary_is_report?: boolean
  usage?: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
  handback?: SubagentHandbackOutcome
  handback_report?: SdkHandbackReport
}

// Mirrors notifySessionStateChanged. The CCR bridge already receives this
// via its own listener; SDK consumers (scmuxd, VS Code) need the same signal
// to know when the main turn's generator is idle vs actively producing.
// The 'idle' transition fires AFTER the bg-agent do-while loop exits — so SDK
// consumers can trust it as the authoritative "turn is over" signal even when
// background agents outlived the turn's result.
type SessionStateChangedEvent = {
  type: 'system'
  subtype: 'session_state_changed'
  state: 'idle' | 'running' | 'requires_action'
}

// A PreToolUse hook timed out or could not run, so it never checked the call.
type HookNoVerdictEvent = {
  type: 'system'
  subtype: 'informational'
  content: string
  level: 'warning'
  tag: 'hook_no_verdict'
  hook_no_verdict: {
    hook_event: 'PreToolUse'
    tool_use_id: string
    timed_out: boolean
  }
}

// A notice the terminal UI shows in its footer, for hosts without one.
type NotificationEvent = {
  type: 'system'
  subtype: 'notification'
  key: string
  text: string
  priority: 'immediate' | 'high'
  color?: 'warning'
}

// The session's name: sent at startup when it has one, and on each rename.
type SessionTitleChangedEvent = {
  type: 'system'
  subtype: 'session_title_changed'
  title: string
}

export type SdkEvent =
  | SessionTitleChangedEvent
  | HookNoVerdictEvent
  | NotificationEvent
  | TaskStartedEvent
  | TaskUpdatedEvent
  | BackgroundTasksChangedEvent
  | TaskProgressEvent
  | TaskNotificationSdkEvent
  | SessionStateChangedEvent

// A background agent's own messages, tagged with parent_tool_use_id. They share
// the queue so they stay in order with that agent's task events.
// So does conversation_reset, sent whole: it names the session /clear left.
type SubagentSdkMessage = SDKAssistantMessage | SDKUserMessage | SDKConversationResetMessage

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

// Official 2.1.329: an agent a workflow runs is reported only through the
// workflow's workflow_progress, with no task events of its own.
const workflowAgentTaskIds = new Set<string>()

export function reportTaskOnlyThroughWorkflow(taskId: string): void {
  workflowAgentTaskIds.add(taskId)
}

const MAX_QUEUE_SIZE = 1000
const queue: ((SdkEvent & { session_id: string }) | SubagentSdkMessage)[] = []
let onEnqueue: (() => void) | undefined

/** Called after each queued event, so the output stream can take it right away. */
export function setSdkEventListener(listener: (() => void) | undefined): void {
  onEnqueue = listener
}

export function enqueueSdkEvent(event: SdkEvent | SubagentSdkMessage): void {
  // SDK events are only consumed (drained) in headless/streaming mode.
  // In TUI mode they would accumulate up to the cap and never be read.
  if (!getIsNonInteractiveSession()) {
    return
  }
  if (event.type === 'system' && 'task_id' in event && workflowAgentTaskIds.has(event.task_id)) {
    return
  }
  if (queue.length >= MAX_QUEUE_SIZE) {
    queue.shift()
  }
  if (event.type === 'system' && 'task_id' in event && !('run_id' in event && event.run_id) && runIds.has(event.task_id)) {
    event = { ...event, run_id: runIds.get(event.task_id) }
  }
  // Named for the session it happened in, which /clear may leave before the drain.
  queue.push(event.type === 'system' ? { ...event, session_id: getSessionId() } : event)
  onEnqueue?.()
}

/** Everything queued for the SDK output stream, in order. */
export function drainSdkOutput(): Array<
  (SdkEvent & { uuid: UUID; session_id: string }) | SubagentSdkMessage
> {
  if (queue.length === 0) {
    return []
  }
  return queue.splice(0).map(e => {
    if (e.type !== 'system') return e
    const { session_id, ...event } = e
    return { ...event, uuid: randomUUID(), session_id } as SdkEvent & { uuid: UUID; session_id: string }
  })
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
 * The SDK event for a queued `<task-notification>`, or undefined when it has
 * no <status>: only a terminal notification closes the task for SDK hosts.
 */
export function taskNotificationSdkEvent(
  notification: unknown,
): TaskNotificationSdkEvent | undefined {
  const text = typeof notification === 'string' ? notification : ''
  const tag = (name: string) =>
    text.match(new RegExp(`<${name}>([^<]+)</${name}>`))?.[1]
  const rawStatus = tag('status')
  if (!rawStatus) return undefined
  const status =
    rawStatus === 'failed' || rawStatus === 'stopped'
      ? rawStatus
      : rawStatus === 'killed'
        ? 'stopped'
        : 'completed'

  const usage = text.match(/<usage>([\s\S]*?)<\/usage>/)?.[1] ?? ''
  const totalTokens = usage.match(
    /<(subagent_tokens|total_tokens)>(\d+)<\/\1>/,
  )
  const toolUses = usage.match(/<tool_uses>(\d+)<\/tool_uses>/)
  const durationMs = usage.match(/<duration_ms>(\d+)<\/duration_ms>/)

  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: tag('task-id') ?? '',
    tool_use_id: tag('tool-use-id'),
    status,
    output_file: tag('output-file') ?? '',
    summary: tag('summary') ?? '',
    usage:
      totalTokens && toolUses
        ? {
            total_tokens: parseInt(totalTokens[2]!, 10),
            tool_uses: parseInt(toolUses[1]!, 10),
            duration_ms: durationMs ? parseInt(durationMs[1]!, 10) : 0,
          }
        : undefined,
  }
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
    runId?: string
    toolUseId?: string
    parentTaskId?: string | null
    notificationToMain?: boolean
    summary?: string
    outputFile?: string
    usage?: { total_tokens: number; tool_uses: number; duration_ms: number }
    waiting?: boolean
    /** `summary` is the report its owner is given, with no review to come. */
    summaryIsReport?: boolean
    handback?: SubagentHandbackOutcome
    /** The report a 'send' or 'flagged' hand-back delivered. */
    handbackReport?: SdkHandbackReport
  },
): void {
  enqueueSdkEvent({
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    ...(opts?.runId && { run_id: opts.runId }),
    tool_use_id: opts?.toolUseId,
    ...(opts?.parentTaskId !== undefined && { parent_task_id: opts.parentTaskId }),
    ...(opts?.notificationToMain && { notification_to_main: true }),
    status,
    output_file: opts?.outputFile ?? '',
    summary: opts?.summary ?? '',
    ...(opts?.summaryIsReport && { summary_is_report: true }),
    usage: opts?.usage,
    ...(opts?.waiting && { waiting: true }),
    ...(opts?.handback !== undefined && { handback: opts.handback }),
    ...(opts?.handbackReport && { handback_report: opts.handbackReport }),
  })
}
