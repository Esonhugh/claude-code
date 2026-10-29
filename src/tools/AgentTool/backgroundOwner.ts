import type { ToolUseContext } from '../../Tool.js'
import {
  drainPendingMessages,
  enqueueAgentNotification,
  isLocalAgentTask,
  type LocalAgentTaskState,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isLocalShellTask } from '../../tasks/LocalShellTask/guards.js'
import { killShellTasksForAgent } from '../../tasks/LocalShellTask/killShellTasks.js'
import { asAgentId } from '../../types/ids.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import {
  dequeueAllMatching,
  enqueuePendingNotification,
  getCommandQueue,
  subscribeToCommandQueue,
} from '../../utils/messageQueueManager.js'
import { extractTextContent } from '../../utils/messages.js'
import { evictTaskOutput } from '../../utils/task/diskOutput.js'
import { PANEL_GRACE_MS, subscribeToTaskChanges, updateTaskState } from '../../utils/task/framework.js'

/** Keep a stopped turn addressable until owned notifications can start its next turn. */
export function parkAgentForChildren({
  taskId,
  toolUseContext,
  resume,
  getWorktreeResult,
}: {
  taskId: string
  toolUseContext: ToolUseContext
  resume?: (prompt: string) => Promise<unknown>
  getWorktreeResult: () => Promise<{ worktreePath?: string; worktreeBranch?: string }>
}): boolean {
  if (!resume) return false
  const get = toolUseContext.getAppStateForTasks ?? toolUseContext.getAppState
  const set = toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState
  const addressed = (command: ReturnType<typeof getCommandQueue>[number]) =>
    command.mode === 'task-notification' && command.agentId === taskId
  const queued = getCommandQueue().filter(addressed)
  const state = get()
  const parent = state.tasks[taskId]
  if (!isLocalAgentTask(parent) || parent.status !== 'completed') return false

  // A delivered child is no longer live, but its queued notification still owns a wake.
  const liveReasons = (owner: LocalAgentTaskState, commands: typeof queued) => {
    const tasks = get().tasks
    return new Set([...owner.keepaliveReasons ?? []].filter(reason => {
      // A finished shell's notification is already queued (addressed) when its status flips.
      if (reason.startsWith('shell:')) return tasks[reason.slice(6)]?.status === 'running'
      if (!reason.startsWith('agent:')) return true
      const childId = reason.slice(6)
      const child = tasks[childId]
      return isLocalAgentTask(child) && child.ownerAgentId === taskId &&
        (!child.notified || commands.some(command => command.taskId === childId))
    }))
  }
  // Background Bash/Monitor the agent left running keep it waiting for their notifications.
  const shells = Object.values(state.tasks).flatMap(task =>
    isLocalShellTask(task) && task.agentId === taskId && task.status === 'running' ? [`shell:${task.id}`] : [])
  const reasons = liveReasons({ ...parent, keepaliveReasons: new Set([...parent.keepaliveReasons ?? [], ...shells]) }, queued)
  updateTaskState<LocalAgentTaskState>(taskId, set, task => ({ ...task, keepaliveReasons: reasons }))
  // SendMessage text queued after the last tool round also starts the next turn.
  if (reasons.size === 0 && queued.length === 0 && parent.pendingMessages.length === 0) return false

  let disposed = false
  let scheduled = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    unsubscribeQueue()
    unsubscribeTasks()
    unregisterCleanup()
  }
  const killShells = () => killShellTasksForAgent(asAgentId(taskId), get, set)
  const reroute = (commands: ReturnType<typeof getCommandQueue>) => {
    for (const command of commands) {
      void enqueuePendingNotification({ ...command, agentId: undefined })
    }
  }
  const notifyTerminal = async (
    task: LocalAgentTaskState,
    status: 'completed' | 'failed' | 'killed',
    error = task.error,
  ) => {
    let worktree: Awaited<ReturnType<typeof getWorktreeResult>> = {}
    try {
      worktree = await getWorktreeResult()
    } catch (cleanupError) {
      logForDebugging(
        `[AgentLifecycle] parked_cleanup_failed agent_id=${taskId}: ${errorMessage(cleanupError)}`,
        { level: 'warn' },
      )
    }
    const result = task.result
    enqueueAgentNotification({
      taskId,
      description: task.description,
      status,
      error,
      setAppState: set,
      finalMessage: result ? extractTextContent(result.content, '\n') : undefined,
      usage: result ? {
        totalTokens: result.totalTokens,
        toolUses: result.totalToolUseCount,
        durationMs: result.totalDurationMs,
      } : undefined,
      toolUseId: task.toolUseId,
      ...worktree,
    })
  }
  const check = async () => {
    if (disposed) return
    const task = get().tasks[taskId]
    if (!isLocalAgentTask(task) || task.status === 'failed' || task.status === 'killed') {
      dispose()
      reroute(dequeueAllMatching(addressed))
      killShells()
      if (isLocalAgentTask(task)) await notifyTerminal(task, task.status as 'failed' | 'killed')
      return
    }
    if (task.status === 'running') {
      dispose()
      return
    }
    if (task.resuming || task.finalizing) return
    const commands = dequeueAllMatching(addressed)
    const stranded = drainPendingMessages(taskId, get, set)
    if (commands.length === 0 && stranded.length === 0) {
      // Children can be marked notified without a queued command (batch kill, inline reply).
      const remaining = liveReasons(task, [])
      if (remaining.size > 0) {
        if (remaining.size < (task.keepaliveReasons?.size ?? 0)) {
          updateTaskState<LocalAgentTaskState>(taskId, set, current => ({ ...current, keepaliveReasons: remaining }))
        }
        return
      }
      dispose()
      task.unregisterCleanup?.()
      updateTaskState<LocalAgentTaskState>(taskId, set, current => ({
        ...current,
        keepaliveReasons: new Set(),
        evictAfter: current.retain ? undefined : Date.now() + PANEL_GRACE_MS,
        abortController: undefined,
        unregisterCleanup: undefined,
        selectedAgent: undefined,
      }))
      void evictTaskOutput(taskId)
      logForDebugging(`[AgentLifecycle] owner_unparked agent_id=${taskId}`)
      await notifyTerminal(task, 'completed')
      return
    }
    const delivered = new Set(commands.flatMap(command => command.taskId ? [`agent:${command.taskId}`] : []))
    updateTaskState<LocalAgentTaskState>(taskId, set, current => ({
      ...current,
      resuming: true,
      keepaliveReasons: new Set([...current.keepaliveReasons ?? []].filter(reason => !delivered.has(reason))),
    }))
    // Stop listening before starting the next turn: bursts cannot resume the same owner twice.
    dispose()
    task.unregisterCleanup?.()
    logForDebugging(`[AgentLifecycle] owner_wake agent_id=${taskId} notifications=${commands.length} messages=${stranded.length}`)
    try {
      await resume([
        ...stranded,
        ...commands.map(command => typeof command.value === 'string' ? command.value : ''),
      ].join('\n\n'))
    } catch (error) {
      const message = errorMessage(error)
      updateTaskState<LocalAgentTaskState>(taskId, set, current => ({
        ...current,
        status: 'failed',
        resuming: false,
        error: message,
        endTime: Date.now(),
        evictAfter: current.retain ? undefined : Date.now() + PANEL_GRACE_MS,
        keepaliveReasons: new Set(),
        abortController: undefined,
        unregisterCleanup: undefined,
      }))
      reroute(commands)
      killShells()
      await notifyTerminal(task, 'failed', message)
      logForDebugging(`[AgentLifecycle] owner_wake_failed agent_id=${taskId}: ${message}`, { level: 'warn' })
    }
  }
  const schedule = () => {
    if (disposed || scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      void check()
    })
  }
  const unsubscribeQueue = subscribeToCommandQueue(schedule)
  const unsubscribeTasks = subscribeToTaskChanges(schedule)
  const unregisterCleanup = registerCleanup(async () => { dispose() })
  logForDebugging(`[AgentLifecycle] owner_parked agent_id=${taskId} keepalive=${reasons.size}`)
  schedule()
  return true
}
