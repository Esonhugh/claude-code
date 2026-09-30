import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import axios from 'axios'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { getCustomHeaders } from '../../services/api/client.js'
import {
  getAnthropicApiKeyWithSource,
  getApiKeyFromApiKeyHelper,
  getApiKeyFromApiKeyHelperCached,
  getConfiguredApiKeyHelper,
  getOpenAIAuthInfo,
} from '../auth.js'
import { CACHE_PATHS } from '../cachePaths.js'
import { checkHasTrustDialogAccepted } from '../config.js'
import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'
import { getClaudeCodeUserAgent } from '../userAgent.js'
import type { ModelOption } from './modelOptions.js'
import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from './providers.js'
export { getFirstPartyModelCacheKey } from './firstPartyModelCacheKey.js'
import { OPENAI_MODEL_CONFIG } from './configs.js'
import { getModelPricingString } from '../modelCost.js'

const FALLBACK_OPENAI_MODEL_OPTIONS = [
  {
    value: OPENAI_MODEL_CONFIG.default,
    label: 'GPT-5.6 Sol',
    description: 'Recommended default for professional coding.',
  },
  {
    value: 'gpt-6-astra',
    label: 'GPT-6 Astra',
    description: 'High-end option for the hardest coding and reasoning tasks.',
  },
  {
    value: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    description: 'Balanced performance and cost for everyday work.',
  },
  {
    value: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    description: 'Fast, low-cost option for simpler tasks.',
  },
] satisfies ModelOption[]

type OpenAIModelsResponse = {
  data?: OpenAIModel[]
  models?: CodexModel[]
}

type OpenAIModel = {
  id?: unknown
  display_name?: unknown
  name?: unknown
  description?: unknown
  visibility?: unknown
  supported_in_api?: unknown
}

type CodexModel = {
  slug?: unknown
  display_name?: unknown
  name?: unknown
  description?: unknown
  visibility?: unknown
  supported_in_api?: unknown
}

type ModelDiscoveryRequest = {
  cacheKey: string
  endpoint: string
  headers: Record<string, string>
  params?: Record<string, string | number>
  parseOptions?: ParseModelOptions
}

export type ModelDiscoveryResult = {
  cacheKey: string
  options: ModelOption[]
}

type ParseModelOptions = {
  includeUnknownModels?: boolean
}

type GatewayModel = {
  id: string
  display_name?: string
  name?: string
  description?: string
  visibility?: string
}

type GatewayModelCache = {
  cacheKey: string
  fetchedAt: number
  models: GatewayModel[]
}

export function getOpenAIModelOptions(): ModelOption[] {
  return FALLBACK_OPENAI_MODEL_OPTIONS.map(option => {
    const pricing = getModelPricingString(option.value)
    const promotion = option.value === OPENAI_MODEL_CONFIG.default
      ? ' (promotional price, verified 2026-09-19)'
      : ''
    return {
      ...option,
      description: `${option.description}${pricing ? ` · ${pricing}${promotion}` : ''} · Static catalog; availability depends on account and endpoint.`,
    }
  })
}

export function isModelDiscoveryEnabled(): boolean {
  if (getAPIProvider() === 'openai') return true
  return (
    getAPIProvider() === 'firstParty' &&
    isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY) &&
    // A first-party base URL is served by the bootstrap endpoint, so discovery
    // only applies to an actual gateway.
    !isFirstPartyAnthropicBaseUrl() &&
    Boolean(process.env.ANTHROPIC_BASE_URL)
  )
}

export function getModelDiscoveryCacheKey(): string | null {
  if (getAPIProvider() !== 'openai') return null
  const auth = getOpenAIAuthInfo()
  if (!auth) return null
  if (auth.isChatGPT) {
    return `openai:chatgpt:${auth.accountId?.trim() || credentialIdentity(auth.accessToken)}`
  }
  return `openai:${getModelsBaseURL(process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1')}:api:${credentialIdentity(auth.accessToken)}`
}

/**
 * Gateway discovery is a second, independent leg next to the first-party
 * bootstrap: it has its own on-disk cache and never writes the bootstrap one.
 */
function isGatewayModelDiscoveryEnabled(): boolean {
  return getAPIProvider() === 'firstParty' && isModelDiscoveryEnabled()
}

type GatewayCredential = {
  credential: string
  kind: 'auth-token' | 'api-key'
}

function getGatewayCredential(): GatewayCredential | null {
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN?.trim()
  if (authToken) return { credential: authToken, kind: 'auth-token' }

  const { key: apiKey, source } = getAnthropicApiKeyWithSource({
    skipRetrievingKeyFromApiKeyHelper: true,
  })
  if (source === 'ANTHROPIC_API_KEY' && apiKey?.trim()) {
    return { credential: apiKey.trim(), kind: 'api-key' }
  }

  if (getConfiguredApiKeyHelper()) {
    const helperKey = getApiKeyFromApiKeyHelperCached()?.trim()
    if (helperKey) return { credential: helperKey, kind: 'auth-token' }
  }
  return null
}

function getGatewayHeaders(
  credential: GatewayCredential,
): Record<string, string> {
  const headers: Record<string, string> = {
    ...(credential.kind === 'auth-token' && {
      Authorization: `Bearer ${credential.credential}`,
    }),
    ...(credential.kind === 'api-key' && {
      'x-api-key': credential.credential,
    }),
    Accept: 'application/json',
    'anthropic-version': '2023-06-01',
    'User-Agent': getClaudeCodeUserAgent(),
  }
  for (const [name, value] of Object.entries(getCustomHeaders())) {
    for (const existing of Object.keys(headers)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing]
    }
    headers[name] = value
  }
  return headers
}

function getGatewayModelCacheKey(
  credential: GatewayCredential,
): string | null {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) return null
  const headers = getGatewayHeaders(credential)
  const authHeaders = Object.entries(headers)
    .filter(([name]) =>
      ['authorization', 'x-api-key'].includes(name.toLowerCase()),
    )
    .sort(([left], [right]) => left.toLowerCase().localeCompare(right.toLowerCase()))
    .map(([name, value]) => `${name.toLowerCase()}:${value}`)
    .join('\n')
  return `anthropic:${getModelsBaseURL(baseUrl)}:auth:${credentialIdentity(authHeaders)}`
}

function readGatewayModelCache(): GatewayModelCache | null {
  let raw: string
  try {
    raw = readFileSync(CACHE_PATHS.gatewayModels(), { encoding: 'utf8' })
  } catch {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const { cacheKey, fetchedAt, models } = parsed as Partial<GatewayModelCache>
    if (typeof cacheKey !== 'string' || !Array.isArray(models)) return null
    return {
      cacheKey,
      fetchedAt: typeof fetchedAt === 'number' ? fetchedAt : 0,
      models: models
        .filter(
          (model): model is GatewayModel =>
            typeof model?.id === 'string' && model.id.length > 0,
        )
        .map(model => ({
          id: model.id,
          ...(typeof model.display_name === 'string'
            ? { display_name: model.display_name }
            : {}),
          ...(typeof model.name === 'string' ? { name: model.name } : {}),
          ...(typeof model.description === 'string'
            ? { description: model.description }
            : {}),
          ...(typeof model.visibility === 'string'
            ? { visibility: model.visibility }
            : {}),
        })),
    }
  } catch {
    logForDebugging('[Gateway discovery] Ignoring unreadable cache')
    return null
  }
}

export function getGatewayModelOptions(): ModelOption[] {
  if (!isGatewayModelDiscoveryEnabled()) return []
  const credential = getGatewayCredential()
  if (!credential) return []
  const cache = readGatewayModelCache()
  // A cache written for another gateway or credential says nothing about this one.
  if (!cache || cache.cacheKey !== getGatewayModelCacheKey(credential)) return []
  return cache.models.map(model => {
    const label = model.display_name || model.name || model.id
    const hasDescription = Boolean(model.description)
    return {
      value: model.id,
      label: model.visibility === 'hide' ? `${label} (Hidden)` : label,
      description:
        model.visibility === 'hide'
          ? `Hidden by gateway; API support is enabled.${hasDescription ? ` ${model.description}` : ''}`
          : (model.description ?? 'From gateway'),
    }
  })
}

/** Fetch the gateway model list and persist it to its own disk cache. */
export async function fetchGatewayModels(): Promise<void> {
  if (!isGatewayModelDiscoveryEnabled()) {
    logForDebugging('[Gateway discovery] Skipped: not enabled')
    return
  }
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) return

  const isTrusted = checkHasTrustDialogAccepted()
  if (!process.env.ANTHROPIC_AUTH_TOKEN && getConfiguredApiKeyHelper() && isTrusted) {
    await getApiKeyFromApiKeyHelper(getIsNonInteractiveSession())
  }
  const credential = getGatewayCredential()
  if (!credential) {
    logForDebugging(
      isTrusted
        ? '[Gateway discovery] Skipped: no credential (ANTHROPIC_AUTH_TOKEN, apiKeyHelper, or API key)'
        : '[Gateway discovery] Skipped: apiKeyHelper requires workspace trust',
    )
    return
  }
  const cacheKey = getGatewayModelCacheKey(credential)
  if (!cacheKey) return

  const headers = getGatewayHeaders(credential)

  const timeoutMs = Number(
    process.env.CLAUDE_CODE_GATEWAY_MODEL_DISCOVERY_TIMEOUT_MS,
  )
  try {
    const response = await axios.get<OpenAIModelsResponse>(
      getModelsEndpoint(baseUrl),
      {
        headers,
        // A gateway lists every model it proxies, so page past the default 20.
        params: { limit: 1000 },
        timeout:
          Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 3000,
      },
    )
    if (!Array.isArray(response.data?.data)) {
      logForDebugging('[Gateway discovery] Fetch failed: invalid response')
      return
    }
    const models: GatewayModel[] = response.data.data
      .filter(model => typeof model.id === 'string' && model.id.length > 0)
      .filter(model => model.supported_in_api !== false)
      .map(model => ({
        id: model.id as string,
        ...(typeof model.display_name === 'string'
          ? { display_name: model.display_name }
          : {}),
        ...(typeof model.name === 'string' ? { name: model.name } : {}),
        ...(typeof model.description === 'string'
          ? { description: model.description }
          : {}),
        ...(typeof model.visibility === 'string'
          ? { visibility: model.visibility }
          : {}),
      }))
    writeGatewayModelCache({ cacheKey, fetchedAt: Date.now(), models })
    logForDebugging(`[Gateway discovery] Cached ${models.length} models`)
  } catch (error) {
    logForDebugging(
      `[Gateway discovery] Fetch failed: ${axios.isAxiosError(error) ? (error.response?.status ?? error.code) : 'unknown'}`,
    )
  }
}

function writeGatewayModelCache(cache: GatewayModelCache): void {
  const path = CACHE_PATHS.gatewayModels()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(cache), { encoding: 'utf8' })
  } catch (error) {
    logForDebugging(
      `[Gateway discovery] Cache write failed: ${error instanceof Error ? error.message : 'unknown'}`,
    )
  }
}

export async function fetchModelOptions(): Promise<ModelOption[] | null> {
  const result = await fetchModelDiscoveryResult()
  return result?.options ?? null
}

export async function fetchModelDiscoveryResult(): Promise<ModelDiscoveryResult | null> {
  const request = getModelDiscoveryRequest()
  if (!request) return null

  try {
    const response = await axios.get<OpenAIModelsResponse>(request.endpoint, {
      headers: request.headers,
      params: request.params,
      timeout: 5000,
    })

    if (
      !Array.isArray(response.data.data) &&
      !Array.isArray(response.data.models)
    ) {
      logForDebugging('[Model discovery] Fetch failed: invalid response')
      return null
    }
    const options = parseOpenAIModelOptions(response.data, request.parseOptions)
    logForDebugging(`[Model discovery] Fetched ${options.length} options`)
    return { cacheKey: request.cacheKey, options }
  } catch (error) {
    logForDebugging(
      `[Model discovery] Fetch failed: ${axios.isAxiosError(error) ? (error.response?.status ?? error.code) : 'unknown'}`,
    )
    return null
  }
}

function getModelDiscoveryRequest(): ModelDiscoveryRequest | null {
  if (getAPIProvider() !== 'openai') return null
  const auth = getOpenAIAuthInfo()
  if (!auth) {
    logForDebugging('[Model discovery] Skipped: no OpenAI auth')
    return null
  }

  const customBaseURL = process.env.OPENAI_BASE_URL
  return {
    cacheKey: auth.isChatGPT
      ? `openai:chatgpt:${auth.accountId?.trim() || credentialIdentity(auth.accessToken)}`
      : `openai:${getModelsBaseURL(customBaseURL ?? 'https://api.openai.com/v1')}:api:${credentialIdentity(auth.accessToken)}`,
    endpoint: auth.isChatGPT
      ? 'https://chatgpt.com/backend-api/codex/models'
      : getModelsEndpoint(customBaseURL ?? 'https://api.openai.com/v1'),
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      Accept: 'application/json',
      'User-Agent': getClaudeCodeUserAgent(),
      ...(auth.isChatGPT
        ? {
            Referer: 'https://chatgpt.com/',
            Origin: 'https://chatgpt.com',
            ...(auth.accountId ? { 'chatgpt-account-id': auth.accountId } : {}),
          }
        : {}),
    },
    ...(auth.isChatGPT ? { params: { client_version: MACRO.VERSION } } : {}),
    parseOptions: {
      includeUnknownModels: !auth.isChatGPT && Boolean(customBaseURL),
    },
  }
}

function credentialIdentity(credential: string): string {
  return createHash('sha256').update(credential).digest('hex').slice(0, 16)
}

function getModelsBaseURL(baseURL: string): string {
  const normalized = baseURL.replace(/\/+$/, '')
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`
}

function getModelsEndpoint(baseURL: string): string {
  return `${getModelsBaseURL(baseURL)}/models`
}

export function parseOpenAIModelOptions(
  data: OpenAIModelsResponse,
  options: ParseModelOptions = {},
): ModelOption[] {
  if (Array.isArray(data.models)) {
    return data.models
      .filter(model => model.supported_in_api !== false)
      .filter(model => typeof model.slug === 'string' && model.slug.length > 0)
      .filter(
        model =>
          options.includeUnknownModels ||
          isOpenAIListableModel(model.slug as string),
      )
      .map(model => {
        const label =
          typeof model.display_name === 'string'
            ? model.display_name
            : typeof model.name === 'string'
              ? model.name
              : (model.slug as string)
        const hasDescription = typeof model.description === 'string'
        const description = hasDescription
          ? (model.description as string)
          : 'OpenAI model'
        const isHidden = model.visibility === 'hide'
        return {
          value: model.slug as string,
          label: isHidden ? `${label} (Hidden)` : label,
          description: isHidden
            ? `Hidden by OpenAI; API support is enabled.${hasDescription ? ` ${description}` : ''}`
            : description,
        }
      })
  }

  if (!Array.isArray(data.data)) {
    return []
  }

  return data.data
    .filter(model => typeof model.id === 'string' && model.id.length > 0)
    .filter(model => model.supported_in_api !== false)
    .filter(
      model =>
        options.includeUnknownModels || isOpenAIListableModel(model.id as string),
    )
    .map(model => {
      const label =
        typeof model.display_name === 'string'
          ? model.display_name
          : typeof model.name === 'string'
            ? model.name
            : (model.id as string)
      const hasDescription = typeof model.description === 'string'
      const description = hasDescription
        ? (model.description as string)
        : 'OpenAI model'
      const isHidden = model.visibility === 'hide'
      return {
        value: model.id as string,
        label: isHidden ? `${label} (Hidden)` : label,
        description: isHidden
          ? `Hidden by OpenAI; API support is enabled.${hasDescription ? ` ${description}` : ''}`
          : description,
      }
    })
}

function isOpenAIListableModel(model: string): boolean {
  const normalized = model.toLowerCase()
  return (
    normalized.startsWith('gpt-') ||
    normalized.startsWith('o') ||
    normalized.startsWith('codex')
  )
}
