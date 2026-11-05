import type { SetAppState } from '../Task.js'
import { createUserMessage } from '../utils/messages.js'
import { injectUserMessageToTeammate } from './InProcessTeammateTask/InProcessTeammateTask.js'
import { isInProcessTeammateTask } from './InProcessTeammateTask/types.js'
import { updateTaskState } from '../utils/task/framework.js'
import { appendMessageToLocalAgent, isLocalAgentTask, type LocalAgentTaskState, queuePendingMessage } from './LocalAgentTask/LocalAgentTask.js'

/**
 * Routes a user message typed into an agent or teammate (REPL agent view,
 * SDK send_task_message). 'resume' means the agent has ended: the message is
 * in its transcript view and the caller must resumeAgentBackground with its
 * own tool context. Throws when the message was not delivered.
 */
export function deliverTaskMessage(
  task: unknown,
  text: string,
  setAppState: SetAppState,
): 'queued' | 'injected' | 'resume' {
  if (isLocalAgentTask(task)) {
    if (task.status !== 'running' && task.stoppedByUser) {
      throw new Error(`agent ${task.id} was stopped by the user`)
    }
    updateTaskState<LocalAgentTaskState>(task.id, setAppState, t => ({ ...t, userMessages: [...(t.userMessages ?? []), text] }))
    if (task.status !== 'running') {
      appendMessageToLocalAgent(task.id, createUserMessage({ content: text }), setAppState)
      return 'resume'
    }
    // Not appended to task.messages: switching the view away drops those, and the
    // agent records its own copy when it reads the queue. queuedUserMessages shows it until then.
    queuePendingMessage(task.id, { text, fromUser: true }, setAppState)
    return 'queued'
  }
  if (isInProcessTeammateTask(task)) {
    if (task.status === 'running' && injectUserMessageToTeammate(task.id, text, setAppState)) return 'injected'
    throw new Error('teammate has stopped; message was not sent')
  }
  throw new Error('no agent or teammate task')
}

/** The user's messages a running agent has not read yet, for its transcript view. */
export function queuedUserMessages(task: LocalAgentTaskState): ReturnType<typeof createUserMessage>[] {
  return task.pendingMessages.flatMap(msg =>
    typeof msg === 'object' && 'fromUser' in msg ? [createUserMessage({ content: msg.text })] : [],
  )
}
