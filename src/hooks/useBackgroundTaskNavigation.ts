import { useIsModalOverlayActive } from '../context/overlayContext.js'
import { KeyboardEvent } from '../ink/events/keyboard-event.js'
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- backward-compat bridge until REPL wires handleKeyDown to <Box onKeyDown>
import { useInput } from '../ink.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import { exitTeammateView } from '../state/teammateViewHelpers.js'
import { isInProcessTeammateTask } from '../tasks/InProcessTeammateTask/types.js'
import { isLocalAgentTask, killAsyncAgent } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import { isBackgroundTask } from '../tasks/types.js'

/**
 * Handles Escape while viewing an agent or teammate transcript, and
 * Shift+Up/Down to open the background tasks dialog. Teammates are selected
 * from the agent panel below the prompt, like official 2.1.311.
 */
export function useBackgroundTaskNavigation(options?: {
  onOpenBackgroundTasks?: () => void
  isActive?: boolean
}): { handleKeyDown: (e: KeyboardEvent) => void } {
  const tasks = useAppState(s => s.tasks)
  const viewSelectionMode = useAppState(s => s.viewSelectionMode)
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  const setAppState = useSetAppState()
  const isModalOverlayActive = useIsModalOverlayActive()
  const footerSelected = useAppState(s => s.footerSelection !== null)

  // Check for non-teammate background tasks (local_agent, local_bash, etc.)
  const hasNonTeammateBackgroundTasks = Object.values(tasks).some(
    // @ts-ignore - recovered code
    t => isBackgroundTask(t) && t.type !== 'in_process_teammate',
  )

  const handleKeyDown = (e: KeyboardEvent): void => {
    if (isModalOverlayActive || footerSelected) return

    // Escape stops a local agent, but only interrupts a teammate's current turn.
    // Terminal transcripts return to main; idle teammates stay alive and viewed.
    if (e.key === 'escape' && viewSelectionMode === 'viewing-agent') {
      e.preventDefault()
      const taskId = viewingAgentTaskId
      if (taskId) {
        const task = tasks[taskId]
        if (isLocalAgentTask(task) && task.status === 'running') {
          killAsyncAgent(taskId, setAppState, 'user')
          return
        }
        if (isInProcessTeammateTask(task) && task.status === 'running') {
          // Abort currentWorkAbortController (stops current turn) NOT abortController (kills teammate)
          task.currentWorkAbortController?.abort()
          return
        }
      }
      // Teammate is not running or task doesn't exist — exit the view
      exitTeammateView(setAppState)
      return
    }

    if (e.shift && (e.key === 'up' || e.key === 'down')) {
      e.preventDefault()
      if (hasNonTeammateBackgroundTasks) {
        options?.onOpenBackgroundTasks?.()
      }
      return
    }
  }

  // Backward-compat bridge: REPL.tsx doesn't yet wire handleKeyDown to
  // <Box onKeyDown>. Subscribe via useInput and adapt InputEvent →
  // KeyboardEvent until the consumer is migrated (separate PR).
  // TODO(onKeyDown-migration): remove once REPL passes handleKeyDown.
  useInput((_input, _key, event) => {
    const keyboardEvent = new KeyboardEvent(event.keypress)
    handleKeyDown(keyboardEvent)
    if (keyboardEvent.defaultPrevented) event.stopImmediatePropagation()
  }, {
    isActive: options?.isActive !== false && !isModalOverlayActive && !footerSelected,
  })

  return { handleKeyDown }
}
