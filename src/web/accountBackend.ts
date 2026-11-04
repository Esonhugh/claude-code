import { rm } from 'fs/promises'
import { installOAuthTokens } from '../cli/handlers/auth.js'
import { performLogout } from '../commands/logout/logout.js'
import { isOAuthTokenExpired } from '../services/oauth/client.js'
import { OAuthService } from '../services/oauth/index.js'
import { loginOpenAIWithOAuth } from '../services/openai-oauth/client.js'
import { getOpenAIAuthPath, saveOpenAIApiKey } from '../services/openai-oauth/storage.js'
import {
  getAnthropicApiKeyWithSource,
  getApiKeyFromConfigOrMacOSKeychain,
  getAuthTokenSource,
  getChatGPTOAuthInfo,
  getClaudeAIOAuthTokens,
  getOauthAccountInfo,
  getOpenAIApiKey,
  getOpenAIAuthInfo,
  getSubscriptionName,
  isUsing3PServices,
  removeApiKey,
  saveApiKey,
} from '../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { getAPIProvider } from '../utils/model/providers.js'
import { getInitialSettings, updateSettingsForSource } from '../utils/settings/settings.js'
import { resetSettingsCache } from '../utils/settings/settingsCache.js'
import type { SettingsJson } from '../utils/settings/types.js'
import type {
  AccountBackend,
  AccountStatus,
  AuthProvider,
  KeyInfo,
  OAuthFlow,
  WebSettings,
} from './account.js'

const BASE_URL_ENV: Record<AuthProvider, string> = {
  anthropic: 'ANTHROPIC_BASE_URL',
  openai: 'OPENAI_BASE_URL',
}
// Env credentials outrank stored ones, so a switch made from the page drops
// them from this process; sessions started afterwards inherit the result.
const ENV_CREDENTIALS: Record<AuthProvider, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY', 'OPENAI_AUTH_TOKEN'],
}
const OAUTH_SOURCES = new Set([
  'claude.ai',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CCR_OAUTH_TOKEN_FILE',
])

/** The last four characters, shown as `····wxyz`; nothing for a key too short to spare them. */
export function keyTail(key: string): string | undefined {
  return key.length < 12 ? undefined : key.slice(-4)
}

function clearAuthCaches(): void {
  getClaudeAIOAuthTokens.cache.clear?.()
  getApiKeyFromConfigOrMacOSKeychain.cache.clear?.()
  getOpenAIAuthInfo.cache.clear?.()
  getChatGPTOAuthInfo.cache.clear?.()
  getOpenAIApiKey.cache.clear?.()
}

function useProvider(provider: AuthProvider): void {
  if (provider === 'openai') process.env.CLAUDE_CODE_USE_OPENAI = '1'
  else delete process.env.CLAUDE_CODE_USE_OPENAI
}

function dropEnvCredentials(provider: AuthProvider): void {
  for (const name of ENV_CREDENTIALS[provider]) delete process.env[name]
}

/** The key `claude -p` would send: the env key first, then the `/login` one. */
function anthropicKey(): { key: string | null; source: string } | undefined {
  if (process.env.ANTHROPIC_API_KEY) {
    return { key: process.env.ANTHROPIC_API_KEY, source: 'ANTHROPIC_API_KEY' }
  }
  try {
    const { key, source } = getAnthropicApiKeyWithSource({ skipRetrievingKeyFromApiKeyHelper: true })
    return source === 'none' ? undefined : { key, source }
  } catch {
    return undefined
  }
}

function openaiKey(): { key: string; source: string } | undefined {
  if (process.env.OPENAI_AUTH_TOKEN) return { key: process.env.OPENAI_AUTH_TOKEN, source: 'OPENAI_AUTH_TOKEN' }
  if (process.env.OPENAI_API_KEY) return { key: process.env.OPENAI_API_KEY, source: 'OPENAI_API_KEY' }
  const info = getOpenAIAuthInfo()
  return info && !info.isChatGPT ? { key: info.accessToken, source: '~/.codex/auth.json' } : undefined
}

function keyInfo(provider: AuthProvider, found: { key: string | null; source: string } | undefined): KeyInfo {
  return {
    provider,
    base_url: process.env[BASE_URL_ENV[provider]] ?? '',
    ...(found && { source: found.source, ...(found.key && { tail: keyTail(found.key) }) }),
  }
}

/** Providers whose OAuth sign-in is stored and still usable (unexpired, or refreshable). */
function savedOAuth(): AuthProvider[] {
  const saved: AuthProvider[] = []
  const claude = getClaudeAIOAuthTokens()
  if (claude?.accessToken && (claude.refreshToken || !isOAuthTokenExpired(claude.expiresAt))) saved.push('anthropic')
  if (getChatGPTOAuthInfo()) saved.push('openai')
  return saved
}

async function status(): Promise<AccountStatus> {
  clearAuthCaches()
  const anthropic = anthropicKey()
  const openai = openaiKey()
  const keys = [keyInfo('anthropic', anthropic), keyInfo('openai', openai)]
  const oauth = savedOAuth()
  if (getAPIProvider() === 'openai') {
    const chatgpt = getChatGPTOAuthInfo()
    if (openai) return { kind: 'apikey', provider: 'openai', source: openai.source, keys, oauth }
    if (chatgpt) {
      return {
        kind: 'chatgpt',
        provider: 'openai',
        name: chatgpt.accountName ?? chatgpt.email,
        plan: chatgpt.planDisplayName ? `ChatGPT ${chatgpt.planDisplayName}` : 'ChatGPT',
        keys,
        oauth,
      }
    }
    return { kind: null, provider: 'openai', keys, oauth }
  }
  if (anthropic?.source === 'ANTHROPIC_API_KEY') {
    return { kind: 'apikey', provider: 'anthropic', source: anthropic.source, keys, oauth }
  }
  const token = getAuthTokenSource()
  if (OAUTH_SOURCES.has(token.source)) {
    const account = getOauthAccountInfo()
    return {
      kind: 'claude',
      provider: 'anthropic',
      name: account?.displayName ?? account?.emailAddress,
      plan: getSubscriptionName(),
      keys,
      oauth,
    }
  }
  if (anthropic) return { kind: 'apikey', provider: 'anthropic', source: anthropic.source, keys, oauth }
  // The rest of what `claude auth status` counts as logged in: ANTHROPIC_AUTH_TOKEN, an apiKeyHelper, a cloud provider.
  if (token.hasToken) return { kind: 'apikey', provider: 'anthropic', source: token.source, keys, oauth }
  if (isUsing3PServices()) return { kind: 'apikey', provider: 'anthropic', source: getAPIProvider(), keys, oauth }
  return { kind: null, provider: 'anthropic', keys, oauth }
}

async function useApiKey(provider: AuthProvider, key: string | undefined): Promise<void> {
  if (key && provider === 'anthropic') {
    // Same order as `/login`: clear the previous credentials, then store.
    await performLogout({ clearOnboarding: false })
    await saveApiKey(key)
  } else if (key) {
    await saveOpenAIApiKey(key)
  }
  if (key) dropEnvCredentials(provider)
  useProvider(provider)
  clearAuthCaches()
}

async function removeStoredApiKey(provider: AuthProvider): Promise<void> {
  if (provider === 'anthropic') {
    await removeApiKey()
  } else if (getOpenAIAuthInfo()?.isChatGPT === false && !process.env.OPENAI_API_KEY && !process.env.OPENAI_AUTH_TOKEN) {
    // auth.json holds only the key here; a ChatGPT login stays.
    await rm(getOpenAIAuthPath(), { force: true })
  }
  dropEnvCredentials(provider)
  clearAuthCaches()
}

async function setBaseUrl(provider: AuthProvider, url: string): Promise<void> {
  const name = BASE_URL_ENV[provider]
  if ((process.env[name] ?? '') === url) return
  // `undefined` deletes the key (updateSettingsForSource's merge rule).
  const { error } = updateSettingsForSource('userSettings', {
    env: { [name]: url || undefined },
  } as SettingsJson)
  if (error) throw error
  if (url) process.env[name] = url
  else delete process.env[name]
}

function startOAuth(provider: AuthProvider): OAuthFlow {
  let gotUrls!: (urls: { url: string; manualUrl: string }) => void
  const urls = new Promise<{ url: string; manualUrl: string }>(resolve => {
    gotUrls = resolve
  })
  const finish = () => {
    dropEnvCredentials(provider)
    useProvider(provider)
    clearAuthCaches()
  }
  if (provider === 'anthropic') {
    const service = new OAuthService()
    const done = service
      .startOAuthFlow(
        async (manualUrl, automaticUrl) => gotUrls({ url: automaticUrl ?? manualUrl, manualUrl }),
        { loginWithClaudeAi: true, skipBrowserOpen: true },
      )
      .then(installOAuthTokens)
      .then(finish)
      .finally(() => service.cleanup())
    return {
      urls: Promise.race([urls, done.then(() => Promise.reject(new Error('Login ended early')))]),
      done,
      submit: code => {
        const [authorizationCode, state] = code.split('#')
        if (!authorizationCode || !state) throw new Error('Paste the whole code, including the part after #')
        service.handleManualAuthCodeInput({ authorizationCode, state })
      },
      cancel: () => service.cleanup(),
    }
  }
  let submit!: (url: string) => void
  let cancel!: () => void
  const manualCallback = new Promise<string>((resolve, reject) => {
    submit = resolve
    cancel = () => reject(new Error('Login cancelled'))
  })
  manualCallback.catch(() => {})
  const done = loginOpenAIWithOAuth({
    openBrowser: async () => {},
    onAuthUrl: url => gotUrls({ url, manualUrl: url }),
    manualCallback,
  }).then(finish)
  return {
    urls: Promise.race([urls, done.then(() => Promise.reject(new Error('Login ended early')))]),
    done,
    submit,
    cancel,
  }
}

async function useOAuth(provider: AuthProvider): Promise<void> {
  if (!savedOAuth().includes(provider)) throw new Error('No saved sign-in for this provider')
  // Same end state as finishing a new login for `provider`.
  dropEnvCredentials(provider)
  useProvider(provider)
  clearAuthCaches()
}

async function logout(): Promise<void> {
  const provider: AuthProvider = getAPIProvider() === 'openai' ? 'openai' : 'anthropic'
  if (provider === 'openai') await rm(getOpenAIAuthPath(), { force: true })
  else await performLogout({ clearOnboarding: false })
  dropEnvCredentials(provider)
  clearAuthCaches()
}

async function readSettings(): Promise<WebSettings> {
  resetSettingsCache()
  const settings = getInitialSettings()
  return {
    uiName: settings.uiName ?? '',
    features: {
      autoCompact: getGlobalConfig().autoCompactEnabled !== false,
      gitInstructions: settings.includeGitInstructions === true,
      memoryExtraction: (settings.memory?.extraction ?? 'off') !== 'off',
      agentSummary: (settings.agentSummary ?? 'full') !== 'off',
      promptSuggestions: settings.promptSuggestionEnabled !== false,
    },
    daybreak: settings.daybreak ?? 'off',
  }
}

const writeSettings: AccountBackend['writeSettings'] = async ({ uiName, features = {}, daybreak }) => {
  const patch: SettingsJson = {}
  if (daybreak !== undefined) patch.daybreak = daybreak
  if (uiName !== undefined) patch.uiName = uiName || undefined
  if (features.gitInstructions !== undefined) patch.includeGitInstructions = features.gitInstructions
  if (features.memoryExtraction !== undefined) {
    patch.memory = { extraction: features.memoryExtraction ? 'sessionEnd' : 'off' }
  }
  if (features.agentSummary !== undefined) patch.agentSummary = features.agentSummary ? 'full' : 'off'
  if (features.promptSuggestions !== undefined) patch.promptSuggestionEnabled = features.promptSuggestions
  if (Object.keys(patch).length) {
    const { error } = updateSettingsForSource('userSettings', patch)
    if (error) throw error
  }
  const autoCompact = features.autoCompact
  if (autoCompact !== undefined) {
    saveGlobalConfig(current => ({ ...current, autoCompactEnabled: autoCompact }))
  }
}

/** The account and settings calls `/login`, `/logout` and `/config` make, in this process. */
export function localAccountBackend(): AccountBackend {
  return {
    status,
    useApiKey,
    removeApiKey: removeStoredApiKey,
    setBaseUrl,
    startOAuth,
    useOAuth,
    logout,
    readSettings,
    writeSettings,
    usage: async () => (await import('../cli/hostControlRequests.js')).buildUsageResponse(),
  }
}
