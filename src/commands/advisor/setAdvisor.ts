import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import type { AppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'
import {
  formatAdvisorModelName,
  isValidAdvisorModel,
  resolveAdvisorModelId,
} from '../../utils/advisor.js'
import { describeHeldAdvisor } from '../../utils/advisorQuery.js'
import { isModelAlias } from '../../utils/model/aliases.js'
import { getModelOptions, type ModelOption } from '../../utils/model/modelOptions.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'

export const ADVISOR_OFF = 'off'

export type AdvisorModelOption = ModelOption & { value: string }

/** The models /advisor offers: the ones /model lists, without its "Default" row. */
export function getAdvisorModelOptions(): AdvisorModelOption[] {
  return getModelOptions().filter(
    (option): option is AdvisorModelOption => option.value !== null,
  )
}

export function getAdvisorChoices(): string[] {
  return [...getAdvisorModelOptions().map(option => option.value), ADVISOR_OFF]
}

export function getAdvisorUsageText(): string {
  return `Usage: /advisor <model|off>. Available: ${getAdvisorChoices().join(', ')}, or any other model name.`
}

export function getInvalidAdvisorText(choice: string): string {
  return `${choice} cannot be used as an advisor. Valid options: ${getAdvisorChoices().join(', ')}`
}

/**
 * The model choice a typed /advisor argument stands for: the spelling /model
 * lists whatever the case typed, else a lower-cased alias, else the name as
 * typed, since the names a gateway serves can be case-sensitive.
 */
export function toAdvisorChoice(typed: string): string {
  const lower = typed.toLowerCase()
  const listed = getAdvisorModelOptions().find(
    option => option.value.toLowerCase() === lower,
  )
  if (listed) return listed.value
  return isModelAlias(lower) ? lower : typed
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
    return `Advisor disabled${suffix}${describeHeldAdvisor(messages, undefined, mainLoopModel)}`
  }
  if (!valid) return getInvalidAdvisorText(model)

  setAppState(s => (s.advisorModel === model ? s : { ...s, advisorModel: model }))
  if (persist) {
    updateSettingsForSource('userSettings', { advisorModel: model })
  }
  return `Advisor set to ${formatAdvisorModelName(model)}${suffix}${describeHeldAdvisor(messages, model, mainLoopModel)}`
}
