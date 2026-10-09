import { randomUUID, type UUID } from 'node:crypto'
import type { AppState } from '../state/AppStateStore.js'
import type { SetAppState } from '../Task.js'
import type { Message, UserMessage } from '../types/message.js'
import { restoreSendMessagePins } from './sendMessagePins.js'

/** Compute rewind state from the retained transcript without mutating it. */
export function prepareConversationRewind(messages: readonly Message[], message: UserMessage) {
  const index = messages.lastIndexOf(message)
  if (index === -1) return undefined
  const retained = messages.slice(0, index)
  return {
    messages: retained,
    metrics: {
      preRewindMessageCount: messages.length,
      postRewindMessageCount: index,
      messagesRemoved: messages.length - index,
      rewindToMessageIndex: index,
    },
    updateAppState: (previous: AppState): AppState => ({
      ...previous,
      sendMessagePins: restoreSendMessagePins(retained),
      diffSidebarVisible: false,
      toolPermissionContext: message.permissionMode && previous.toolPermissionContext.mode !== message.permissionMode
        ? { ...previous.toolPermissionContext, mode: message.permissionMode as typeof previous.toolPermissionContext.mode }
        : previous.toolPermissionContext,
      promptSuggestion: { text: null, promptId: null, shownAt: 0, acceptedAt: 0, generationRequestId: null },
    }),
  }
}

type RewindMetrics = NonNullable<ReturnType<typeof prepareConversationRewind>>['metrics']

/** Apply the plan in the same order as the REPL, with explicit host effects. */
export function rewindConversationTo(message: UserMessage, host: {
  messages: readonly Message[]
  logEvent: (name: 'tengu_conversation_rewind', metrics: RewindMetrics) => void
  setMessages: (messages: Message[]) => void
  resetDiff: () => void
  setConversationId: (id: UUID) => void
  resetMicrocompactState: () => void
  resetContextCollapse: () => void
  setAppState: SetAppState
}): void {
  const plan = prepareConversationRewind(host.messages, message)
  if (!plan) return
  host.logEvent('tengu_conversation_rewind', plan.metrics)
  host.setMessages(plan.messages)
  host.resetDiff()
  // Changing the conversation ID must follow replacing the transcript.
  host.setConversationId(randomUUID())
  host.resetMicrocompactState()
  host.resetContextCollapse()
  host.setAppState(plan.updateAppState)
}
