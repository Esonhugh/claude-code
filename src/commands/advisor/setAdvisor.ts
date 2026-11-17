import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import type { AppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'
import {
  formatAdvisorModelName,
  getAdvisorAliasOptions,
  isAdvisorPairingAllowed,
  isValidAdvisorModel,
  modelSupportsAdvisor,
  resolveAdvisorModelId,
} from '../../utils/advisor.js'
import { describeHeldAdvisor } from '../../utils/advisorQuery.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'

export const ADVISOR_OFF = 'off'

export function getAdvisorChoices(): string[] {
  return [...getAdvisorAliasOptions(), ADVISOR_OFF]
}

export function getAdvisorUsageText(): string {
  return `Usage: /advisor <${getAdvisorChoices().join('|')}>`
}

export function getInvalidAdvisorText(choice: string): string {
  return `${choice} cannot be used as an advisor. Valid options: ${getAdvisorChoices().join(', ')}`
}

/**
 * Applies an /advisor choice (official `VDt`): updates the session, persists
 * to user settings, and explains what the current conversation keeps.
 * `choice` is an alias, a model id, or "off".
 */
export function setAdvisor({
  choice,
  mainLoopModel,
  setAppState,
  messages,
  persist = true,
}: {
  choice: string
  mainLoopModel: string
  setAppState: (f: (prev: AppState) => AppState) => void
  messages: readonly Message[]
  persist?: boolean
}): string {
  const model = choice === ADVISOR_OFF ? undefined : choice
  const valid = model === undefined || isValidAdvisorModel(resolveAdvisorModelId(model))
  logEvent('tengu_advisor_command', {
    advisor: (model === undefined
      ? 'off'
      : valid
        ? choice
        : 'invalid') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    remote: false,
  })
  const suffix = persist
    ? ''
    : ' for this session — run /advisor in the terminal to change your default'

  if (model === undefined) {
    setAppState(s =>
      s.advisorModel === undefined ? s : { ...s, advisorModel: undefined },
    )
    if (persist) {
      updateSettingsForSource('userSettings', { advisorModel: undefined })
    }
    return `Advisor disabled${suffix}${describeHeldAdvisor(messages, undefined)}`
  }
  if (!valid) return getInvalidAdvisorText(model)

  setAppState(s => (s.advisorModel === model ? s : { ...s, advisorModel: model }))
  if (persist) {
    updateSettingsForSource('userSettings', { advisorModel: model })
  }
  const advisorName = formatAdvisorModelName(model)
  const mainName = formatAdvisorModelName(mainLoopModel)
  let text = `Advisor set to ${advisorName}${suffix}`
  if (!modelSupportsAdvisor(mainLoopModel)) {
    text += `\nNote: the current main model (${mainName}) does not support the advisor. It will activate when you switch to a supported main model.`
  } else if (!isAdvisorPairingAllowed(mainLoopModel, model)) {
    text += `\nNote: ${advisorName} is less capable than the current main model (${mainName}), so the advisor will not activate. Choose a more capable advisor, or switch to a smaller main model.`
  }
  return text + describeHeldAdvisor(messages, model)
}
