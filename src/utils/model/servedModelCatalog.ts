import axios from 'axios'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getOauthConfig } from '../../constants/oauth.js'
import { getOrganizationUUID } from '../../services/oauth/client.js'
import { getClaudeAIOAuthTokens, hasProfileScope, isClaudeAISubscriber } from '../auth.js'
import { getGlobalConfig } from '../config.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { withOAuth401Retry } from '../http.js'
import { logForDebugging } from '../debug.js'
import { isEssentialTrafficOnly } from '../privacyLevel.js'
import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from './providers.js'

const CACHE_VERSION = 2
const MAX_CACHE_BYTES = 4 * 1024 * 1024
const DEFAULT_STALE_MS = 60 * 60 * 1000
const SERVED_MODEL_CATALOG_SURFACE = 'cc'
const ANTHROPIC_VERSION = '2023-06-01'
const ANTHROPIC_CLIENT_PLATFORM = 'claude_code_cli'
const etagByCachePath = new Map<string, string>()
let latestCatalog: { scope: ServedModelCatalogScope; catalog: ServedModelCatalog } | undefined

export type ServedModelThinking = {
  type?: string
  effort_options?: Array<{ id?: string; recommended?: boolean; [key: string]: unknown }>
  [key: string]: unknown
}

export type ServedModelRow = {
  id: string
  name: string
  short_name?: string
  description?: string
  section?: string
  thinking?: ServedModelThinking
  [key: string]: unknown
}

export type ServedModelCatalog = {
  surface: string
  config: {
    id: string
    models: ServedModelRow[]
    [key: string]: unknown
  }
  state?: {
    id: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export type ServedModelCatalogScope = {
  provider: 'anthropic'
  endpoint: string
  authMethod: 'claude-ai-oauth'
  organizationUUID: string
}

type ServedModelCatalogCache = {
  version: number
  fetchedAt: number
  staleAt: number
  catalog: ServedModelCatalog
}

type ServedCatalogResponse = {
  status: number
  data: unknown
  headers: Record<string, string | undefined>
}

export type ServedCatalogRequestOptions = {
  headers: Record<string, string>
  timeout: number
}

export type ServedCatalogRequest = (
  url: string,
  options: ServedCatalogRequestOptions,
) => Promise<ServedCatalogResponse>

type FetchOptions = {
  /** Dependency injection for tests; production resolves the current OAuth scope. */
  scope?: ServedModelCatalogScope | null
  /** Dependency injection for tests; production rereads the current access token. */
  accessToken?: string
  cacheDir?: string
  now?: () => number
  request?: ServedCatalogRequest
}

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function endpointKey(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex').slice(0, 16)
}

export function getServedModelCatalogEndpoint(
  baseApiUrl: string,
  organizationUUID: string,
): string {
  return `${baseApiUrl}/api/organizations/${encodeURIComponent(organizationUUID)}/model_selector/${SERVED_MODEL_CATALOG_SURFACE}`
}

/**
 * Cache identity deliberately contains provider, endpoint, auth method and org.
 * It does not contain an access-token hash: OAuth access tokens rotate.
 */
export function getServedModelCatalogCachePath(
  scope: ServedModelCatalogScope,
  cacheDir = join(getClaudeConfigHomeDir(), 'cache', 'model-catalog'),
): string {
  const filename = [
    safePathPart(scope.provider),
    safePathPart(scope.authMethod),
    safePathPart(scope.organizationUUID),
    endpointKey(scope.endpoint),
    'cc.json',
  ].join('-')
  return join(cacheDir, filename)
}

function isEligibleForServedCatalog(): boolean {
  return (
    !isEssentialTrafficOnly() &&
    getAPIProvider() === 'firstParty' &&
    isFirstPartyAnthropicBaseUrl() &&
    isClaudeAISubscriber() &&
    hasProfileScope()
  )
}

export function isServedModelCatalogEligible(): boolean {
  return isEligibleForServedCatalog()
}

function normalizeCatalog(value: unknown): ServedModelCatalog | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Record<string, unknown>
  if (input.surface !== undefined && input.surface !== 'cc') return undefined
  const configValue = input.config
  if (!configValue || typeof configValue !== 'object') return undefined
  const config = configValue as Record<string, unknown>
  if (typeof config.id !== 'string' || !Array.isArray(config.models)) return undefined

  const models = config.models.filter((row): row is ServedModelRow => {
    if (!row || typeof row !== 'object') return false
    const candidate = row as Record<string, unknown>
    return typeof candidate.id === 'string' && typeof candidate.name === 'string'
  })
  if (models.length === 0) return undefined

  return {
    ...input,
    surface: typeof input.surface === 'string' ? input.surface : 'cc',
    config: { ...config, models },
  } as ServedModelCatalog
}

export function parseServedModelCatalog(value: unknown): ServedModelCatalog | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Record<string, unknown>
  const wireConfig = Array.isArray(input.model_selector_config)
    ? input.model_selector_config.find(
        candidate =>
          candidate &&
          typeof candidate === 'object' &&
          (candidate as Record<string, unknown>).id === SERVED_MODEL_CATALOG_SURFACE,
      )
    : undefined
  const wireState = Array.isArray(input.model_selector_state)
    ? input.model_selector_state.find(
        candidate =>
          candidate &&
          typeof candidate === 'object' &&
          (candidate as Record<string, unknown>).id === SERVED_MODEL_CATALOG_SURFACE,
      )
    : undefined
  const candidates = [
    input.catalog,
    input.data && typeof input.data === 'object'
      ? (input.data as Record<string, unknown>).catalog
      : undefined,
    wireConfig
      ? {
          surface: SERVED_MODEL_CATALOG_SURFACE,
          config: wireConfig,
          ...(wireState && typeof wireState === 'object' ? { state: wireState } : {}),
        }
      : undefined,
    value,
  ]
  for (const candidate of candidates) {
    const catalog = normalizeCatalog(candidate)
    if (catalog) return catalog
  }
  return undefined
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const timestamp = Date.parse(value)
    if (Number.isFinite(timestamp)) return timestamp
  }
  return undefined
}

async function readCache(path: string): Promise<ServedModelCatalogCache | undefined> {
  try {
    if ((await stat(path)).size > MAX_CACHE_BYTES) return undefined
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    const catalog = parseServedModelCatalog(parsed.catalog)
    if (
      parsed.version !== CACHE_VERSION ||
      typeof parsed.fetchedAt !== 'number' ||
      typeof parsed.staleAt !== 'number' ||
      !catalog
    ) return undefined
    return {
      version: CACHE_VERSION,
      fetchedAt: parsed.fetchedAt,
      staleAt: parsed.staleAt,
      catalog,
    }
  } catch {
    return undefined
  }
}

function readCacheSync(path: string): ServedModelCatalogCache | undefined {
  try {
    if (statSync(path).size > MAX_CACHE_BYTES) return undefined
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const catalog = parseServedModelCatalog(parsed.catalog)
    if (
      parsed.version !== CACHE_VERSION ||
      typeof parsed.fetchedAt !== 'number' ||
      typeof parsed.staleAt !== 'number' ||
      !catalog
    ) return undefined
    return { version: CACHE_VERSION, fetchedAt: parsed.fetchedAt, staleAt: parsed.staleAt, catalog }
  } catch {
    return undefined
  }
}

async function writeCache(path: string, cache: ServedModelCatalogCache): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  const serialized = JSON.stringify(cache)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CACHE_BYTES) {
    throw new Error('served model catalog cache is oversized')
  }
  await writeFile(path, serialized, { encoding: 'utf8', mode: 0o600 })
}

async function resolveProductionScope(): Promise<ServedModelCatalogScope | null> {
  if (!isEligibleForServedCatalog()) return null
  const organizationUUID = await getOrganizationUUID()
  if (!organizationUUID) return null
  return {
    provider: 'anthropic',
    authMethod: 'claude-ai-oauth',
    organizationUUID,
    endpoint: getServedModelCatalogEndpoint(
      getOauthConfig().BASE_API_URL,
      organizationUUID,
    ),
  }
}

async function defaultRequest(
  url: string,
  options: ServedCatalogRequestOptions,
): Promise<ServedCatalogResponse> {
  const response = await axios.get<unknown>(url, {
    headers: options.headers,
    timeout: options.timeout,
    maxContentLength: MAX_CACHE_BYTES,
    validateStatus: status => (status >= 200 && status < 300) || status === 304,
  })
  return {
    status: response.status,
    data: response.data,
    headers: Object.fromEntries(
      Object.entries(response.headers).map(([key, value]) => [key, typeof value === 'string' ? value : undefined]),
    ),
  }
}

export async function fetchServedModelCatalog(
  options: FetchOptions = {},
): Promise<ServedModelCatalog | undefined> {
  let scope: ServedModelCatalogScope | null
  try {
    scope = options.scope === undefined ? await resolveProductionScope() : options.scope
  } catch (error) {
    logForDebugging(
      `[servedCatalog] scope resolution failed: ${error instanceof Error ? error.message : 'unknown'}`,
    )
    return undefined
  }
  if (!scope) {
    logForDebugging('[servedCatalog] off (not_claude_ai_auth)')
    return undefined
  }

  const cachePath = getServedModelCatalogCachePath(scope, options.cacheDir)
  const now = options.now ?? Date.now
  const cached = await readCache(cachePath)
  const currentTime = now()
  if (cached && currentTime < cached.staleAt) {
    logForDebugging(
      `[servedCatalog] primary: using served rows (${cached.catalog.config.models.length} rows via cache over the org route, fetched ${Math.max(0, Math.round((currentTime - cached.fetchedAt) / 1000))}s ago); the served list replaces the compiled picker for this session`,
    )
    latestCatalog = { scope, catalog: cached.catalog }
    return cached.catalog
  }

  let accessToken: string | undefined
  try {
    accessToken = options.accessToken ?? getClaudeAIOAuthTokens()?.accessToken
  } catch {
    return cached?.catalog
  }
  if (!accessToken) {
    if (cached) latestCatalog = { scope, catalog: cached.catalog }
    return cached?.catalog
  }

  try {
    let scopeChanged = false
    const response = await withOAuth401Retry(async () => {
      if (options.scope === undefined) {
        const currentOrganizationUUID = await getOrganizationUUID()
        if (currentOrganizationUUID !== scope.organizationUUID) {
          scopeChanged = true
          return null
        }
      }
      const currentAccessToken = options.accessToken ?? getClaudeAIOAuthTokens()?.accessToken
      if (!currentAccessToken) return null
      const headers: Record<string, string> = {
        Authorization: `Bearer ${currentAccessToken}`,
        'Content-Type': 'application/json',
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-client-platform': ANTHROPIC_CLIENT_PLATFORM,
        'x-organization-uuid': scope.organizationUUID,
      }
      const etag = etagByCachePath.get(cachePath)
      if (etag) headers['If-None-Match'] = etag
      return (options.request ?? defaultRequest)(scope.endpoint, {
        headers,
        timeout: 5000,
      })
    })

    if (scopeChanged) return undefined
    if (!response) {
      if (cached) latestCatalog = { scope, catalog: cached.catalog }
      return cached?.catalog
    }
    if (response.status === 304) {
      if (!cached) return undefined
      logForDebugging('[servedCatalog] fetch (org): not modified')
      const refreshedCache: ServedModelCatalogCache = {
        ...cached,
        fetchedAt: currentTime,
        staleAt: currentTime + DEFAULT_STALE_MS,
      }
      try {
        await writeCache(cachePath, refreshedCache)
      } catch {
        logForDebugging('[servedCatalog] cache write failed')
      }
      latestCatalog = { scope, catalog: cached.catalog }
      return cached.catalog
    }
    if (response.status < 200 || response.status >= 300) {
      logForDebugging(`[servedCatalog] response failed: ${response.status}`)
      if (cached) latestCatalog = { scope, catalog: cached.catalog }
      return cached?.catalog
    }

    const catalog = parseServedModelCatalog(response.data)
    if (!catalog) {
      logForDebugging('[servedCatalog] response failed validation')
      if (cached) latestCatalog = { scope, catalog: cached.catalog }
      return cached?.catalog
    }

    logForDebugging(
      `[servedCatalog] fetch (org) ok: ${catalog.config.models.length} rows`,
    )

    const responseBody = response.data && typeof response.data === 'object'
      ? response.data as Record<string, unknown>
      : {}
    const etag = response.headers.etag ?? response.headers.ETag
    if (etag) etagByCachePath.set(cachePath, etag)
    const staleAt = parseTimestamp(responseBody.staleAt ?? responseBody.stale_at)
      ?? currentTime + DEFAULT_STALE_MS
    const nextCache: ServedModelCatalogCache = {
      version: CACHE_VERSION,
      fetchedAt: currentTime,
      staleAt,
      catalog,
    }
    try {
      await writeCache(cachePath, nextCache)
    } catch {
      logForDebugging('[servedCatalog] cache write failed')
    }
    latestCatalog = { scope, catalog }
    return catalog
  } catch (error) {
    logForDebugging(
      `[servedCatalog] fetch failed: ${error instanceof Error ? error.message : 'unknown'}`,
    )
    if (cached) latestCatalog = { scope, catalog: cached.catalog }
    return cached?.catalog
  }
}

/**
 * Synchronous picker/validator read. Startup refresh is asynchronous, so the
 * last catalog remains usable while a stale cache is being refreshed.
 */
export function getServedModelCatalog(): ServedModelCatalog | undefined {
  if (!isEligibleForServedCatalog()) return undefined
  const organizationUUID = getGlobalConfig().oauthAccount?.organizationUuid
  if (!organizationUUID) return latestCatalog?.catalog
  const scope: ServedModelCatalogScope = {
    provider: 'anthropic',
    authMethod: 'claude-ai-oauth',
    organizationUUID,
    endpoint: getServedModelCatalogEndpoint(
      getOauthConfig().BASE_API_URL,
      organizationUUID,
    ),
  }
  return readCacheSync(getServedModelCatalogCachePath(scope))?.catalog
}

export function hasServedModel(model: string): boolean {
  const catalog = getServedModelCatalog()
  if (!catalog) return false
  const baseModel = model.replace(/\[(?:1|2)m\]$/i, '')
  return catalog.config.models.some(row => row.id === baseModel)
}
