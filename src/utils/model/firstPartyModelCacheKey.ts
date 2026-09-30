import { createHash } from 'node:crypto'
import { getOauthConfig } from '../../constants/oauth.js'
import {
  getAnthropicApiKeyWithSource,
  getClaudeAIOAuthTokens,
  hasProfileScope,
} from '../auth.js'
import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from './providers.js'

export function getFirstPartyModelCacheKey(): string | null {
  if (getAPIProvider() !== 'firstParty' || !isFirstPartyAnthropicBaseUrl()) {
    return null
  }

  const oauth = getClaudeAIOAuthTokens()?.accessToken?.trim()
  if (oauth && hasProfileScope()) {
    return `anthropic:${getModelsBaseURL(getOauthConfig().BASE_API_URL)}:oauth:${credentialIdentity(oauth)}`
  }

  const apiKey = getAnthropicApiKeyWithSource({
    skipRetrievingKeyFromApiKeyHelper: true,
  }).key?.trim()
  return apiKey
    ? `anthropic:${getModelsBaseURL(getOauthConfig().BASE_API_URL)}:api-key:${credentialIdentity(apiKey)}`
    : null
}

function credentialIdentity(credential: string): string {
  return createHash('sha256').update(credential).digest('hex').slice(0, 16)
}

function getModelsBaseURL(baseURL: string): string {
  const normalized = baseURL.replace(/\/+$/, '')
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`
}
