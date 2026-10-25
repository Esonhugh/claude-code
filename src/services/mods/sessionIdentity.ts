import {
  getAnthropicApiKeyWithSource,
  getAuthTokenSource,
  getOauthAccountInfo,
} from '../../utils/auth.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { getSettingsForSource } from '../../utils/settings/settings.js'

export type ModSessionIdentity = {
  kind: string
  organizationId?: string
  email?: string
  isVerified: boolean
}

/**
 * How the session is signed in, for a managed mod's $.session.identity().
 * The organization and email are answered only where managed
 * forceLoginOrgUUID names the login's organization. This build keeps no
 * server-verified profile for the process, so isVerified is always false.
 */
export function modSessionIdentity(): ModSessionIdentity {
  const provider = getAPIProvider()
  if (provider !== 'firstParty') return { kind: provider, isVerified: false }
  const token = getAuthTokenSource().source
  const apiKey = getAnthropicApiKeyWithSource({ skipRetrievingKeyFromApiKeyHelper: true }).source
  const kind = token === 'claude.ai' ? 'claude.ai'
    : token !== 'none' && token !== 'apiKeyHelper' ? 'oauth-token'
    : apiKey === '/login managed key' ? 'console'
    : token === 'none' && apiKey === 'none' ? 'none'
    : 'api-key'
  const account = kind === 'claude.ai' || kind === 'console' ? getOauthAccountInfo() : undefined
  const pinned = getSettingsForSource('policySettings')?.forceLoginOrgUUID
  const organizationId = account?.organizationUuid
  if (organizationId === undefined || pinned !== organizationId) return { kind, isVerified: false }
  return {
    kind,
    organizationId,
    ...(account?.emailAddress ? { email: account.emailAddress } : {}),
    isVerified: false,
  }
}
