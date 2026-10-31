import { setMainLoopModelOverride } from '../../bootstrap/state.js'
import { COMMON_HELP_ARGS, COMMON_INFO_ARGS } from '../../constants/xml.js'
import type { LocalCommandCall } from '../../types/command.js'
import { MODEL_ALIASES } from '../../utils/model/aliases.js'
import {
  getDefaultMainLoopModel,
  getMainLoopModel,
  renderDefaultModelSetting,
} from '../../utils/model/model.js'
import { isModelAllowed } from '../../utils/model/modelAllowlist.js'
import {
  checkModelSwitch,
  getModelSwitchHookInfo,
} from '../../utils/model/modelSwitchHooks.js'
import { validateModel } from '../../utils/model/validateModel.js'
import { notifySessionMetadataChanged } from '../../utils/sessionState.js'

const USAGE = `Usage: /model <name>. Available: ${MODEL_ALIASES.join(', ')}, default, or a full model ID.`

export const call: LocalCommandCall = async (args, context) => {
  const name = args.trim()
  if (!name || COMMON_INFO_ARGS.includes(name)) {
    return {
      type: 'text',
      value: `Current model: \`${renderDefaultModelSetting(getMainLoopModel())}\`\n${USAGE}`,
    }
  }
  if (COMMON_HELP_ARGS.includes(name)) {
    return { type: 'text', value: USAGE }
  }

  const requested = name === 'default' ? null : name
  if (requested !== null) {
    if (!isModelAllowed(requested)) {
      return {
        type: 'text',
        value: `Model '${requested}' is not available. Your organization restricts model selection.`,
      }
    }
    if (
      !(MODEL_ALIASES as readonly string[]).includes(requested.toLowerCase())
    ) {
      const { valid, error } = await validateModel(requested)
      if (!valid) {
        return { type: 'text', value: error || `Model '${requested}' not found` }
      }
    }
  }

  const verdict = await checkModelSwitch(
    getModelSwitchHookInfo(requested, context.messages),
    'command',
  )
  if (verdict.decision !== 'proceed') {
    return {
      type: 'text',
      value:
        verdict.decision === 'ask'
          ? `Model switch needs confirmation${verdict.reason ? `: ${verdict.reason}` : ''} (run /model interactively to confirm)`
          : `Model switch blocked by PreModelSwitch hook: ${verdict.reason ?? 'no reason given'}`,
    }
  }

  // Headless switches last for this session only; settings.json keeps its
  // saved default (official 2.1.311).
  const model = requested ?? getDefaultMainLoopModel()
  setMainLoopModelOverride(model)
  notifySessionMetadataChanged({ model })
  return {
    type: 'text',
    value: `Set model to \`${renderDefaultModelSetting(model)}\` for this session only`,
  }
}
