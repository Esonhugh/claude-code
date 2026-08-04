/**
 * Selectors for deriving computed state from AppState.
 * Keep selectors pure and simple - just data extraction, no side effects.
 */

import type { InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js'
import { isInProcessTeammateTask } from '../tasks/InProcessTeammateTask/types.js'
import {
  isLocalAgentTask,
  type LocalAgentTaskState,
} from '../tasks/LocalAgentTask/LocalAgentTask.js'
import type { AppState } from './AppStateStore.js'

export type ViewedAgentTask = InProcessTeammateTaskState | LocalAgentTaskState

/**
 * Get the currently viewed agent task, if any.
 * Both in-process teammates and local agents have an independent transcript.
 */
export function getViewedAgentTask(
  appState: Pick<AppState, 'viewingAgentTaskId' | 'tasks'>,
): ViewedAgentTask | undefined {
  const { viewingAgentTaskId, tasks } = appState
  if (!viewingAgentTaskId) return undefined

  const task = tasks[viewingAgentTaskId]
  if (isInProcessTeammateTask(task) || isLocalAgentTask(task)) return task
  return undefined
}

/**
 * Get the currently viewed teammate task, if any.
 * Returns undefined if the current view is the leader or a local agent.
 */
export function getViewedTeammateTask(
  appState: Pick<AppState, 'viewingAgentTaskId' | 'tasks'>,
): InProcessTeammateTaskState | undefined {
  const task = getViewedAgentTask(appState)
  return task && isInProcessTeammateTask(task) ? task : undefined
}

/**
 * Return type for getActiveAgentForInput selector.
 * Discriminated union for type-safe input routing.
 */
export type ActiveAgentForInput =
  | { type: 'leader' }
  | { type: 'viewed'; task: InProcessTeammateTaskState }
  | { type: 'named_agent'; task: LocalAgentTaskState }

/**
 * Determine where user input should be routed.
 * Returns:
 * - { type: 'leader' } when not viewing a teammate (input goes to leader)
 * - { type: 'viewed', task } when viewing an agent (input goes to that agent)
 *
 * Used by input routing logic to direct user messages to the correct agent.
 */
export function getActiveAgentForInput(
  appState: AppState,
): ActiveAgentForInput {
  const viewedTask = getViewedAgentTask(appState)
  if (!viewedTask) {
    return { type: 'leader' }
  }
  if (isInProcessTeammateTask(viewedTask)) {
    return { type: 'viewed', task: viewedTask }
  }
  return { type: 'named_agent', task: viewedTask }
}
