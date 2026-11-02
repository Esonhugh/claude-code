import type { SetAppState } from '../Task.js'
import { createUserMessage } from '../utils/messages.js'
import { injectUserMessageToTeammate } from './InProcessTeammateTask/InProcessTeammateTask.js'
import { isInProcessTeammateTask } from './InProcessTeammateTask/types.js'
import { appendMessageToLocalAgent, isLocalAgentTask, queuePendingMessage } from './LocalAgentTask/LocalAgentTask.js'

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
    appendMessageToLocalAgent(task.id, createUserMessage({ content: text }), setAppState)
    if (task.status !== 'running') return 'resume'
    queuePendingMessage(task.id, text, setAppState)
    return 'queued'
  }
  if (isInProcessTeammateTask(task)) {
    if (task.status === 'running' && injectUserMessageToTeammate(task.id, text, setAppState)) return 'injected'
    throw new Error('teammate has stopped; message was not sent')
  }
  throw new Error('no agent or teammate task')
}
