import type { Command } from '../../commands.js'
import { getOpenAIAuthInfo, hasAnthropicApiKeyAuth } from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

export default () =>
  ({
    type: 'local-jsx',
    name: 'login',
    description: isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI)
      ? getOpenAIAuthInfo()
        ? 'Switch OpenAI accounts'
        : 'Sign in with your OpenAI account'
      : hasAnthropicApiKeyAuth()
        ? 'Switch Anthropic accounts'
        : 'Sign in with your Anthropic account',
    isEnabled: () => !isEnvTruthy(process.env.DISABLE_LOGIN_COMMAND),
    load: () => import('./login.js'),
  }) satisfies Command
