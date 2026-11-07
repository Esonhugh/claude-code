import type { ModelInfo } from 'src/entrypoints/agentSdkTypes.js'
import { modelSupportsAutoMode } from 'src/utils/betas.js'
import { getSupportedEffortLevelsForModel, modelSupportsEffort } from 'src/utils/effort.js'
import { isFastModeSupportedByModel } from 'src/utils/fastMode.js'
import {
  modelSupportsAdaptiveThinking,
  rejectsDisabledThinking,
  requiresAlwaysOnAdaptiveThinking,
} from 'src/utils/thinking.js'
import { getDefaultMainLoopModel, parseUserSpecifiedModel } from './model.js'
import { getModelOptions } from './modelOptions.js'
import { getGatewayModelOptions } from './openaiModelOptions.js'
import { getContextWindowTiers } from '../context.js'

// The effortLevel setting's levels (ultracode is a mode, not a level): a gateway passes the value
// through to its model, so its discovered models offer them all instead of the Claude allowlist.
export const GATEWAY_EFFORT_LEVELS: NonNullable<ModelInfo['supportedEffortLevels']> = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

/** The model picker's options as SDK `ModelInfo`: the initialize response's `models`, and `claude web`'s list before any session. */
export function getModelInfos(): ModelInfo[] {
  const gateway = new Set(getGatewayModelOptions().map(option => option.value))
  return getModelOptions().map(option => {
    const modelId = option.value === null ? 'default' : option.value
    const resolvedModel =
      modelId === 'default'
        ? getDefaultMainLoopModel()
        : parseUserSpecifiedModel(modelId)
    const fromGateway = gateway.has(modelId)
    const hasEffort = fromGateway || modelSupportsEffort(resolvedModel)
    const hasAdaptiveThinking = modelSupportsAdaptiveThinking(resolvedModel)
    const hasFastMode = isFastModeSupportedByModel(option.value)
    const hasAutoMode = modelSupportsAutoMode(resolvedModel)
    const contextWindowTiers = getContextWindowTiers(resolvedModel)
    return {
      value: modelId,
      resolvedModel,
      displayName: option.label,
      description: option.description,
      ...(hasEffort && {
        supportsEffort: true,
        supportedEffortLevels: fromGateway
          ? GATEWAY_EFFORT_LEVELS
          : [...getSupportedEffortLevelsForModel(resolvedModel)],
      }),
      ...(hasAdaptiveThinking && { supportsAdaptiveThinking: true }),
      ...(hasFastMode && { supportsFastMode: true }),
      ...(hasAutoMode && { supportsAutoMode: true }),
      // Off maps to adaptive thinking on these models.
      supportsThinkingOff:
        !requiresAlwaysOnAdaptiveThinking(resolvedModel) &&
        !rejectsDisabledThinking(resolvedModel),
      ...(contextWindowTiers.length > 0 && { contextWindowTiers }),
    }
  })
}
