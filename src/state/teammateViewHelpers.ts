import { logEvent } from '../services/analytics/index.js'
import { logForDebugging } from '../utils/debug.js'
import { isTerminalTaskStatus } from '../Task.js'
import type { InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js'
import type { LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js'

// Inlined from framework.ts — importing creates a cycle through
// BackgroundTasksDialog. Keep in sync with PANEL_GRACE_MS there.
const PANEL_GRACE_MS = 30_000

import type { AppState } from './AppState.js'

// Inline type checks instead of importing task guards — breaks runtime edges
// through BackgroundTasksDialog.
function isLocalAgent(task: unknown): task is LocalAgentTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'local_agent'
  )
}

function isInProcessTeammate(
  task: unknown,
): task is InProcessTeammateTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'in_process_teammate'
  )
}

/**
 * Return the task released back to stub form: retain dropped, messages
 * cleared, evictAfter set if terminal. Shared by exitTeammateView and
 * the switch-away path in enterTeammateView.
 */
function release(task: LocalAgentTaskState): LocalAgentTaskState {
  return {
    ...task,
    retain: false,
    messages: undefined,
    diskLoaded: false,
    evictAfter: isTerminalTaskStatus(task.status)
      ? Date.now() + PANEL_GRACE_MS
      : undefined,
  }
}

/**
 * Transitions the UI to view a teammate's transcript.
 * Sets viewingAgentTaskId and, for local_agent, retain: true (blocks eviction,
 * enables stream-append, triggers disk bootstrap) and clears evictAfter.
 * If switching from another agent, releases the previous one back to stub.
 */
export function enterTeammateView(
  taskId: string,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  logEvent('tengu_transcript_view_enter', {})
  setAppState(prev => {
    const task = prev.tasks[taskId]
    const prevId = prev.viewingAgentTaskId
    const prevTask = prevId !== undefined ? prev.tasks[prevId] : undefined
    const switchingLocal =
      prevId !== undefined &&
      prevId !== taskId &&
      isLocalAgent(prevTask) &&
      prevTask.retain
    const switchingTeammate =
      prevId !== undefined &&
      prevId !== taskId &&
      isInProcessTeammate(prevTask) &&
      prevTask.retain
    const switching = switchingLocal || switchingTeammate
    const needsRetain =
      (isLocalAgent(task) && (!task.retain || task.evictAfter !== undefined)) ||
      (isInProcessTeammate(task) && !task.retain)
    const needsView =
      prev.viewingAgentTaskId !== taskId ||
      prev.viewSelectionMode !== 'viewing-agent'
    if (!needsRetain && !needsView && !switching) return prev
    let tasks = prev.tasks
    if (switching || needsRetain) {
      tasks = { ...prev.tasks }
      if (switchingLocal) tasks[prevId] = release(prevTask)
      if (switchingTeammate) {
        const { [prevId]: _, ...remainingTasks } = tasks
        tasks = isTerminalTaskStatus(prevTask.status)
          ? remainingTasks
          : { ...tasks, [prevId]: { ...prevTask, retain: undefined } }
      }
      if (needsRetain) {
        if (isLocalAgent(task)) {
          tasks[taskId] = { ...task, retain: true, evictAfter: undefined }
        } else if (isInProcessTeammate(task)) {
          tasks[taskId] = { ...task, retain: true }
        }
      }
    }
    if (prev.viewingAgentTaskId !== taskId) {
      logForDebugging(
        `[viewed_agent_changed] before=${prevId ?? 'main'} after=${taskId} type=${task?.type ?? 'missing'} reason=${prevId ? 'switch' : 'enter'}`,
      )
    }
    return {
      ...prev,
      viewingAgentTaskId: taskId,
      viewSelectionMode: 'viewing-agent',
      tasks,
    }
  })
}

/**
 * Exit teammate transcript view and return to leader's view.
 * Drops retain and clears messages back to stub form; if terminal,
 * schedules eviction via evictAfter so the row lingers briefly.
 */
export function exitTeammateView(
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  logEvent('tengu_transcript_view_exit', {})
  setAppState(prev => {
    const id = prev.viewingAgentTaskId
    const cleared = {
      ...prev,
      viewingAgentTaskId: undefined,
      viewSelectionMode: 'none' as const,
    }
    if (id === undefined) {
      return prev.viewSelectionMode === 'none' ? prev : cleared
    }
    const task = prev.tasks[id]
    if (prev.viewingAgentTaskId !== undefined) {
      logForDebugging(
        `[viewed_agent_changed] before=${id} after=main type=${task?.type ?? 'missing'} reason=exit`,
      )
    }
    if (isLocalAgent(task) && task.retain) {
      return {
        ...cleared,
        tasks: { ...prev.tasks, [id]: release(task) },
      }
    }
    if (isInProcessTeammate(task) && task.retain) {
      if (isTerminalTaskStatus(task.status)) {
        const { [id]: _, ...remainingTasks } = prev.tasks
        return { ...cleared, tasks: remainingTasks }
      }
      return {
        ...cleared,
        tasks: {
          ...prev.tasks,
          [id]: { ...task, retain: undefined },
        },
      }
    }
    return cleared
  })
}

/**
 * Context-sensitive x: running → abort, terminal → dismiss.
 * Dismiss sets evictAfter=0 so the filter hides immediately.
 * If viewing the dismissed agent, also exits to leader.
 */
export function stopOrDismissAgent(
  taskId: string,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  setAppState(prev => {
    const task = prev.tasks[taskId]
    if (!isLocalAgent(task)) return prev
    if (task.status === 'running') {
      task.abortController?.abort()
      return prev
    }
    if (task.evictAfter === 0) return prev
    const viewingThis = prev.viewingAgentTaskId === taskId
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: { ...release(task), evictAfter: 0 },
      },
      ...(viewingThis && {
        viewingAgentTaskId: undefined,
        viewSelectionMode: 'none',
      }),
    }
  })
}
