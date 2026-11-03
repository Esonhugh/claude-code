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

/** The model picker's options as SDK `ModelInfo`: the initialize response's `models`, and `claude web`'s list before any session. */
export function getModelInfos(): ModelInfo[] {
  return getModelOptions().map(option => {
    const modelId = option.value === null ? 'default' : option.value
    const resolvedModel =
      modelId === 'default'
        ? getDefaultMainLoopModel()
        : parseUserSpecifiedModel(modelId)
    const hasEffort = modelSupportsEffort(resolvedModel)
    const hasAdaptiveThinking = modelSupportsAdaptiveThinking(resolvedModel)
    const hasFastMode = isFastModeSupportedByModel(option.value)
    const hasAutoMode = modelSupportsAutoMode(resolvedModel)
    return {
      value: modelId,
      resolvedModel,
      displayName: option.label,
      description: option.description,
      ...(hasEffort && {
        supportsEffort: true,
        supportedEffortLevels: [
          ...getSupportedEffortLevelsForModel(resolvedModel),
        ],
      }),
      ...(hasAdaptiveThinking && { supportsAdaptiveThinking: true }),
      ...(hasFastMode && { supportsFastMode: true }),
      ...(hasAutoMode && { supportsAutoMode: true }),
      // Off maps to adaptive thinking on these models.
      supportsThinkingOff:
        !requiresAlwaysOnAdaptiveThinking(resolvedModel) &&
        !rejectsDisabledThinking(resolvedModel),
    }
  })
}
