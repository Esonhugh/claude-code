import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { getGlobalConfig } from '../config.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../envUtils.js'
import { getFirstPartyModelCacheKey } from './firstPartyModelCacheKey.js'
import { getCanonicalName } from './model.js'
import { getAPIProvider } from './providers.js'

const leanModels = new Set(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5', 'claude-fable-5', 'claude-fable-5-1', 'claude-mythos-5'])
const canonical = (model: string) => getCanonicalName(model).replace(/\[1m\]/gi, '').toLowerCase()
const legacy = (model: string) => /claude-3-|haiku|sonnet/.test(model) || /^claude-opus-4-(0|1|5|6|7)$/.test(model)

export function promptCapabilityOverride(model: string, wanted: string): boolean | undefined {
  const name = canonical(model)
  let value: boolean | undefined
  for (const clause of process.env.CLAUDE_CODE_MODEL_CAPABILITIES?.split(';') ?? []) {
    const separator = clause.indexOf('=')
    if (separator !== -1) {
      const selector = clause.slice(0, separator).trim()
      if (!selector || !(selector.endsWith('*') ? name.startsWith(selector.slice(0, -1)) : name === selector)) continue
    }
    for (const item of (separator === -1 ? clause : clause.slice(separator + 1)).split(',')) {
      const flag = item.trim()
      if (flag === wanted) value = true
      if (flag === '-' + wanted) value = false
    }
  }
  return value
}

function clientData(): Record<string, unknown> | undefined {
  const key = getFirstPartyModelCacheKey()
  const config = getGlobalConfig()
  return key && config.bootstrapCacheKey === key ? config.clientDataCache ?? undefined : undefined
}

export function shouldUseLeanPrompt(model: string): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT)) return true
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT)) return false
  const name = canonical(model)
  const capability = promptCapabilityOverride(model, 'lean_prompt')
  if (capability === true || capability === undefined && (leanModels.has(name) || /-eap$/i.test(name))) return true
  if (capability === undefined && !legacy(name) && getAPIProvider() === 'firstParty') return true
  if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_velvet_tide', false)) return true
  const flag = clientData()?.simple_system_prompt
  return typeof flag === 'object' && flag !== null && Object.entries(flag).some(([selector, value]) => value === true && name.includes(selector))
}

export function usesDetailedCommunication(model: string): boolean {
  return promptCapabilityOverride(model, 'fable_5_1_prompt_bundle') ?? ['claude-fable-5-1', 'claude-mythos-5'].includes(canonical(model))
}

export function usesTurnUpdates(model: string): boolean {
  if (process.env.CLAUDE_CODE_TURN_UPDATES !== undefined) return isEnvTruthy(process.env.CLAUDE_CODE_TURN_UPDATES)
  const override = promptCapabilityOverride(model, 'turn_updates')
  if (override !== undefined) return override
  const flag = clientData()?.turn_updates
  return usesDetailedCommunication(model) ? flag !== false : flag === true
}
