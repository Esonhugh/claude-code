import { useEffect } from 'react'
import { useAppState, useSetAppState } from '../state/AppState.js'
import { exitTeammateView } from '../state/teammateViewHelpers.js'

/** Keep terminal transcripts open; only a removed task invalidates the view. */
export function useTeammateViewAutoExit(): void {
  const setAppState = useSetAppState()
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  const taskExists = useAppState(s =>
    s.viewingAgentTaskId !== undefined &&
    s.tasks[s.viewingAgentTaskId] !== undefined,
  )

  useEffect(() => {
    if (viewingAgentTaskId && !taskExists) {
      exitTeammateView(setAppState)
    }
  }, [viewingAgentTaskId, taskExists, setAppState])
}
