import { getOpenAIAuthInfo } from '../auth.js'
import { isEnvTruthy } from '../envUtils.js'
import { type PermissionMode, permissionModeTitle } from './PermissionMode.js'

/**
 * "Approve for me" is auto mode in OpenAI mode with a ChatGPT OAuth login: the
 * auto-mode classifier reviews each permission request with the OpenAI model.
 * It is the only way auto mode is offered in this build.
 */
export function isApproveForMeAvailable(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI) &&
    getOpenAIAuthInfo()?.isChatGPT === true
}

export function getPermissionModeFooterLabel(mode: PermissionMode): string {
  return mode === 'auto' && isApproveForMeAvailable()
    ? 'auto (Approve for me)'
    : permissionModeTitle(mode).toLowerCase()
}
