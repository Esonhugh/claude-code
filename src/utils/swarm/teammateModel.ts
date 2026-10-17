import { getGlobalConfig } from '../config.js'
import { getAgentModel } from '../model/agent.js'
import {
  getDefaultMainLoopModel,
  getUserSpecifiedModelSetting,
} from '../model/model.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'

export function getHardcodedTeammateModelFallback(): string {
  return getDefaultMainLoopModel()
}

/** Resolve once before spawning; every backend executes and records this model. */
export function resolveTeammateModel(
  toolModel: string | undefined,
  leaderModel: string | null,
  definitionModel?: string,
  permissionMode?: PermissionMode,
): string {
  const parentModel = leaderModel ?? getHardcodedTeammateModelFallback()
  let fallback = definitionModel
  if (
    !process.env.CLAUDE_CODE_SUBAGENT_MODEL &&
    toolModel === undefined &&
    fallback === undefined
  ) {
    const configured = getGlobalConfig().teammateDefaultModel
    if (configured !== undefined) {
      fallback = configured ?? 'inherit'
    } else {
      fallback = getUserSpecifiedModelSetting() != null
        ? 'inherit'
        : getHardcodedTeammateModelFallback()
    }
  }
  return getAgentModel(fallback, parentModel, toolModel, permissionMode)
}
