import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from '../utils/model/providers.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

const OPENAI_MODEL = /^(gpt-|codex|o\d)/i

/**
 * Earlier builds saved the OpenAI /model pick to `model`, which official Claude
 * Code reads too and then sends to Anthropic. Move it to `openaiModel`. A custom
 * Anthropic base URL may serve such a name, so it is left alone there.
 */
export function migrateOpenAIModelToOwnSetting(): void {
  const settings = getSettingsForSource('userSettings')
  const model = settings?.model
  if (typeof model !== 'string' || !OPENAI_MODEL.test(model)) return
  if (getAPIProvider() !== 'openai' && !isFirstPartyAnthropicBaseUrl()) return
  updateSettingsForSource('userSettings', {
    openaiModel: settings?.openaiModel ?? model,
    model: undefined,
  })
}
