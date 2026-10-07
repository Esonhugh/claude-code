import { getGlobalConfig } from '../config.js'
import { getFirstPartyModelCacheKey } from './firstPartyModelCacheKey.js'
import { getCanonicalName } from './model.js'

function capabilityOverride(model: string, wanted: string): boolean | undefined {
  let value: boolean | undefined
  for (const clause of process.env.CLAUDE_CODE_MODEL_CAPABILITIES?.split(';') ?? []) {
    const separator = clause.indexOf('=')
    if (separator !== -1) {
      const selector = clause.slice(0, separator).trim()
      if (!selector || !(selector.endsWith('*') ? model.startsWith(selector.slice(0, -1)) : model === selector)) continue
    }
    for (const item of (separator === -1 ? clause : clause.slice(separator + 1)).split(',')) {
      const flag = item.trim()
      if (flag === wanted) value = true
      if (flag === '-' + wanted) value = false
    }
  }
  return value
}

export function shouldHideAssistantSummaryHint(model: string | undefined): boolean {
  if (model === undefined) return false
  const canonical = getCanonicalName(model).replace(/\[1m\]/gi, '')
  const override = capabilityOverride(canonical, 'quizzical_shore')
  if (override !== undefined) return override
  const cowork = !process.env.CLAUDE_CODE_CHILD_SESSION &&
    ['local-agent', 'local_agent', 'remote_cowork', 'remote_cowork_trigger'].includes(process.env.CLAUDE_CODE_ENTRYPOINT ?? '')
  const bundle = capabilityOverride(canonical, 'opus_5_5_prompt_bundle') ?? canonical === 'claude-opus-5-5'
  const defaultHidden = bundle && !cowork
  // Only the current provider/credential bootstrap cache is eligible. Never apply a stale account's flags.
  const config = getGlobalConfig()
  const cacheKey = getFirstPartyModelCacheKey()
  const flag = cacheKey && config.bootstrapCacheKey === cacheKey ? config.clientDataCache?.quizzical_shore : undefined
  return defaultHidden ? flag !== false : flag === true
}
