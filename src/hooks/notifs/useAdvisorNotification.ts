import { useEffect, useRef } from 'react'
import { useNotifications } from 'src/context/notifications.js'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import { useAppState } from '../../state/AppState.js'
import {
  isAdvisorEnabled,
  isAdvisorPairingAllowed,
  isValidAdvisorModel,
  modelSupportsAdvisor,
  resolveAdvisorModelId,
} from '../../utils/advisor.js'

export type AdvisorNotice = 'on' | 'pairing'

export const ADVISOR_NOTICE_TEXT: Record<AdvisorNotice, string> = {
  on: 'Advisor Tool (experimental) is on and may use more tokens · /advisor',
  pairing:
    'Advisor will not activate on the main model (advisor is less capable); subagents may still use it and may use more tokens · /advisor',
}

/** Which advisor notice applies (official startup notice `advisor-tool`). */
export function getAdvisorNotice(
  advisorModel: string | undefined,
  mainLoopModel: string,
): AdvisorNotice | undefined {
  if (getIsRemoteMode() || !isAdvisorEnabled()) return undefined
  if (!advisorModel || !modelSupportsAdvisor(mainLoopModel)) return undefined
  if (!isValidAdvisorModel(resolveAdvisorModelId(advisorModel))) return undefined
  return isAdvisorPairingAllowed(mainLoopModel, advisorModel) ? 'on' : 'pairing'
}

/** Announces the advisor at startup and whenever the pairing changes. */
export function useAdvisorNotification(mainLoopModel: string): void {
  const { addNotification } = useNotifications()
  const advisorModel = useAppState(s => s.advisorModel)
  const shown = useRef<AdvisorNotice | undefined>(undefined)

  useEffect(() => {
    const notice = getAdvisorNotice(advisorModel, mainLoopModel)
    if (notice === shown.current) return
    shown.current = notice
    if (notice === undefined) return
    addNotification({
      key: 'advisor-experimental',
      text: ADVISOR_NOTICE_TEXT[notice],
      priority: 'medium',
      fold: (_, incoming) => incoming,
    })
  }, [advisorModel, mainLoopModel, addNotification])
}
