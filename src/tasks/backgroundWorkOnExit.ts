import type { AppState } from '../state/AppStateStore.js'
import { truncate } from '../utils/truncate.js'
import { isInProcessTeammateTask } from './InProcessTeammateTask/types.js'
import { isLocalAgentTask } from './LocalAgentTask/LocalAgentTask.js'
import { isBackgroundTask } from './types.js'

export type BackgroundWorkItem = { label: string; detail: string }

const TASK_LABELS: Record<string, string> = {
  local_agent: 'subagent',
  local_workflow: 'workflow',
  local_bash: 'shell',
  monitor_mcp: 'monitor',
  in_process_teammate: 'teammate',
  interactive_terminal: 'terminal',
}

const DETAIL_WIDTH = 50

// Official 2.1.311: what /exit stops, shown before exiting. Idle teammates,
// cloud sessions and dreams survive the exit, so they are not listed.
export function getBackgroundWorkOnExit(
  tasks: AppState['tasks'],
): BackgroundWorkItem[] {
  const items: BackgroundWorkItem[] = []
  for (const task of Object.values(tasks)) {
    if (!isBackgroundTask(task)) continue
    if (task.type === 'remote_agent' || task.type === 'dream') continue
    if (isLocalAgentTask(task) && task.abortController?.signal.aborted) continue
    if (isInProcessTeammateTask(task)) {
      if (task.isIdle) continue
      if (task.currentWorkAbortController?.signal.aborted) continue
    }
    items.push({
      label: TASK_LABELS[task.type] ?? task.type,
      detail: truncate(task.description, DETAIL_WIDTH, true),
    })
  }
  return items
}
