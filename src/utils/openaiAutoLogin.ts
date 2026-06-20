import { getOpenAIApiKey } from './auth.js'
import { isEnvTruthy } from './envUtils.js'

export function shouldShowOpenAIAutoLogin(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI) && !getOpenAIApiKey()
}
