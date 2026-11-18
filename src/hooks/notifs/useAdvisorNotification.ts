import { useEffect, useRef } from 'react'
import { useNotifications } from 'src/context/notifications.js'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import { useAppState } from '../../state/AppState.js'
import {
  isAdvisorEnabled,
  isValidAdvisorModel,
  resolveAdvisorModelId,
} from '../../utils/advisor.js'

export const ADVISOR_NOTICE_TEXT =
  'Advisor Tool (experimental) is on and may use more tokens · /advisor'

/** Whether the advisor notice applies (official startup notice `advisor-tool`). */
export function hasAdvisorNotice(advisorModel: string | undefined): boolean {
  if (getIsRemoteMode() || !isAdvisorEnabled() || !advisorModel) return false
  return isValidAdvisorModel(resolveAdvisorModelId(advisorModel))
}

/** Announces the advisor at startup and whenever it is turned on. */
export function useAdvisorNotification(): void {
  const { addNotification } = useNotifications()
  const advisorModel = useAppState(s => s.advisorModel)
  const shown = useRef(false)

  useEffect(() => {
    const notice = hasAdvisorNotice(advisorModel)
    if (notice === shown.current) return
    shown.current = notice
    if (!notice) return
    addNotification({
      key: 'advisor-experimental',
      text: ADVISOR_NOTICE_TEXT,
      priority: 'medium',
      fold: (_, incoming) => incoming,
    })
  }, [advisorModel, addNotification])
}
