import { getOpenAIAuthInfo, type OpenAIAuthInfo } from '../../utils/auth.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { checkAndRefreshOpenAITokenIfNeeded } from '../openai-oauth/refresh.js'
import type { CodexAppsEligibility } from './types.js'

export function getCodexAppsEligibility(): CodexAppsEligibility {
  if (process.env.CLAUDE_CODE_DISABLE_CODEX_APPS === '1') {
    return { eligible: false, reason: 'feature-disabled' }
  }
  if (getAPIProvider() !== 'openai') {
    return { eligible: false, reason: 'provider-not-openai' }
  }

  const auth = getOpenAIAuthInfo()
  if (!auth?.isChatGPT || !auth.accessToken) {
    return { eligible: false, reason: 'chatgpt-oauth-required' }
  }

  return { eligible: true }
}

/**
 * Resolve fresh ChatGPT OAuth credentials immediately before an Apps request.
 * API keys, OPENAI_AUTH_TOKEN and auth.json OPENAI_API_KEY all produce
 * isChatGPT=false in getOpenAIAuthInfo(), so they fail closed here.
 */
export async function requireCodexAppsOAuth({
  forceRefresh = false,
}: {
  forceRefresh?: boolean
} = {}): Promise<OpenAIAuthInfo> {
  if (process.env.CLAUDE_CODE_DISABLE_CODEX_APPS === '1') {
    throw new Error('Codex Apps is disabled')
  }
  if (getAPIProvider() !== 'openai') {
    throw new Error('Codex Apps requires the OpenAI provider')
  }

  await checkAndRefreshOpenAITokenIfNeeded({ force: forceRefresh })
  const auth = getOpenAIAuthInfo()
  if (!auth?.isChatGPT || !auth.accessToken) {
    throw new Error(
      'Codex Apps requires ChatGPT OAuth authentication; API keys and bearer-token overrides are not supported',
    )
  }
  return auth
}
