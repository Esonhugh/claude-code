import type { AppState } from '../../state/AppStateStore.js'
import { isTerminalTaskStatus } from '../../taskStatus.js'
import {
  type InProcessTeammateTaskState,
  isInProcessTeammateTask,
} from '../../tasks/InProcessTeammateTask/types.js'
import { emitTaskTerminatedSdk } from '../sdkEventQueue.js'
import { PANEL_GRACE_MS } from '../task/framework.js'
import { unassignTeammateTasks } from '../tasks.js'
import { removeTeammateFromTeamFile } from './teamHelpers.js'

/**
 * Mark a shut-down teammate's in-process tasks terminal so hasRunningTeammates
 * becomes false and the spinner stops. Without this, out-of-process (tmux)
 * teammate tasks stay status:'running' forever because only in-process
 * teammates have a runner that sets 'completed'. notified + evictAfter mirror
 * killInProcessTeammate so retention evicts the task after the panel grace
 * period. Tasks the runner or a kill already ended are left alone. Returns the
 * tasks that were still running so the caller can close their SDK bookend once.
 */
export function completeTeammateTasksOnShutdown(
  tasks: AppState['tasks'],
  teammateId: string,
  now = Date.now(),
): { tasks: AppState['tasks']; shutDown: InProcessTeammateTaskState[] } {
  const updatedTasks = { ...tasks }
  const shutDown: InProcessTeammateTaskState[] = []
  for (const [tid, task] of Object.entries(updatedTasks)) {
    if (
      !isInProcessTeammateTask(task) ||
      task.identity.agentId !== teammateId ||
      isTerminalTaskStatus(task.status)
    ) {
      continue
    }
    shutDown.push(task)
    updatedTasks[tid] = {
      ...task,
      status: 'completed' as const,
      notified: true,
      endTime: now,
      retain: task.retain ?? false,
      evictAfter: task.retain ? undefined : now + PANEL_GRACE_MS,
    }
  }
  return { tasks: updatedTasks, shutDown }
}

/**
 * Leader-side handling of a teammate's shutdown_approved message: remove the
 * member from the team file, unassign its tasks, drop it from
 * teamContext.teammates and end its tasks. Shared by the interactive inbox
 * poller, the -p team-lead poll loop and the mailbox attachment path so all
 * three leave the same state behind. `removed` is false when the teammate was
 * already gone from teamContext (another path handled the approval first).
 */
export async function handleTeammateShutdownApproved({
  teamName,
  teammateId,
  teammateName,
  setAppState,
}: {
  teamName: string | undefined
  teammateId: string
  teammateName: string
  setAppState: (f: (prev: AppState) => AppState) => void
}): Promise<{ notificationMessage: string; removed: boolean }> {
  if (teamName) {
    await removeTeammateFromTeamFile(teamName, {
      agentId: teammateId,
      name: teammateName,
    })
  }

  const { notificationMessage } = teamName
    ? await unassignTeammateTasks(teamName, teammateId, teammateName, 'shutdown')
    : { notificationMessage: `${teammateName} has shut down.` }

  let removed = false
  let shutDownTasks: InProcessTeammateTaskState[] = []
  setAppState(prev => {
    if (!prev.teamContext?.teammates) return prev
    if (!(teammateId in prev.teamContext.teammates)) return prev
    const { [teammateId]: _, ...remainingTeammates } =
      prev.teamContext.teammates
    const { tasks, shutDown } = completeTeammateTasksOnShutdown(
      prev.tasks,
      teammateId,
    )
    removed = true
    shutDownTasks = shutDown
    return {
      ...prev,
      tasks,
      teamContext: { ...prev.teamContext, teammates: remainingTeammates },
    }
  })

  // notified:true pre-set → no XML notification → print.ts won't emit the SDK
  // task_notification. Close the task_started bookend directly.
  for (const task of shutDownTasks) {
    emitTaskTerminatedSdk(task.id, 'completed', {
      toolUseId: task.toolUseId,
      summary: task.identity.agentId,
    })
  }

  return { notificationMessage, removed }
}
