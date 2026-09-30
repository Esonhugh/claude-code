import axios from 'axios'
import isEqual from 'lodash-es/isEqual.js'
import {
  getAnthropicApiKey,
  getClaudeAIOAuthTokens,
  hasProfileScope,
} from 'src/utils/auth.js'
import { z } from 'zod'
import { getOauthConfig, OAUTH_BETA_HEADER } from '../../constants/oauth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { withOAuth401Retry } from '../../utils/http.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import {
  fetchGatewayModels,
  fetchModelDiscoveryResult,
  getFirstPartyModelCacheKey,
  getModelDiscoveryCacheKey,
} from '../../utils/model/openaiModelOptions.js'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from '../../utils/model/providers.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'

const bootstrapResponseSchema = lazySchema(() =>
  z.object({
    // @ts-ignore - recovered code
    client_data: z.record(z.string(), z.unknown()).nullish(),
    auto_compact_windows: z.record(z.string(), z.unknown()).nullish(),
    additional_model_options: z
      .array(
        z
          .object({
            model: z.string(),
            name: z.string(),
            description: z.string(),
          })
          .transform(({ model, name, description }) => ({
            value: model,
            label: name,
            description,
          })),
      )
      .nullish(),
  }),
)

type BootstrapResponse = z.infer<ReturnType<typeof bootstrapResponseSchema>>

type BootstrapResult = {
  cacheKey: string
  response: BootstrapResponse
}

async function fetchBootstrapAPI(): Promise<BootstrapResult | null> {
  if (isEssentialTrafficOnly()) {
    logForDebugging('[Bootstrap] Skipped: Nonessential traffic disabled')
    return null
  }

  if (
    getAPIProvider() !== 'firstParty' ||
    !isFirstPartyAnthropicBaseUrl()
  ) {
    logForDebugging('[Bootstrap] Skipped: 3P provider or gateway')
    return null
  }

  // OAuth preferred (requires user:profile scope — service-key OAuth tokens
  // lack it and would 403). Fall back to API key auth for console users.
  const apiKey = getAnthropicApiKey()
  const hasUsableOAuth =
    getClaudeAIOAuthTokens()?.accessToken && hasProfileScope()
  if (!hasUsableOAuth && !apiKey) {
    logForDebugging('[Bootstrap] Skipped: no usable OAuth or API key')
    return null
  }

  const cacheKey = getFirstPartyModelCacheKey()
  if (!cacheKey) return null
  const endpoint = `${getOauthConfig().BASE_API_URL}/api/claude_cli/bootstrap`

  // withOAuth401Retry handles the refresh-and-retry. API key users fail
  // through on 401 (no refresh mechanism — no OAuth token to pass).
  try {
    return await withOAuth401Retry(async () => {
      // Re-read OAuth each call so the retry picks up the refreshed token.
      const token = getClaudeAIOAuthTokens()?.accessToken
      let authHeaders: Record<string, string>
      if (token && hasProfileScope()) {
        authHeaders = {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': OAUTH_BETA_HEADER,
        }
      } else if (apiKey) {
        authHeaders = { 'x-api-key': apiKey }
      } else {
        logForDebugging('[Bootstrap] No auth available on retry, aborting')
        return null
      }

      logForDebugging('[Bootstrap] Fetching')
      const response = await axios.get<unknown>(endpoint, {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': getClaudeCodeUserAgent(),
          ...authHeaders,
        },
        timeout: 5000,
      })
      const parsed = bootstrapResponseSchema().safeParse(response.data)
      if (!parsed.success) {
        logForDebugging(
          `[Bootstrap] Response failed validation: ${parsed.error.message}`,
        )
        return null
      }
      logForDebugging('[Bootstrap] Fetch ok')
      return { cacheKey, response: parsed.data }
    })
  } catch (error) {
    logForDebugging(
      `[Bootstrap] Fetch failed: ${axios.isAxiosError(error) ? (error.response?.status ?? error.code) : 'unknown'}`,
    )
    throw error
  }
}

/**
 * Fetch bootstrap data from the API and persist to disk cache.
 */
export async function fetchBootstrapData(): Promise<void> {
  if (getAPIProvider() === 'openai') {
    await fetchOpenAIModelOptions()
    return
  }
  // Gateway discovery keeps its own on-disk cache, so it is an independent leg
  // next to the bootstrap: either one failing must not skip the other.
  await Promise.all([fetchGatewayModels(), fetchBootstrapCaches()])
}

/**
 * OpenAI has no bootstrap endpoint: model discovery is the only source, and it
 * owns the keyed `additionalModelOptionsCache` slot. A failed or stale-identity
 * discovery keeps the previous cache.
 */
async function fetchOpenAIModelOptions(): Promise<void> {
  try {
    const discovery = await fetchModelDiscoveryResult()
    if (!discovery || discovery.cacheKey !== getModelDiscoveryCacheKey()) return

    const config = getGlobalConfig()
    const additionalModelOptionsCacheKey =
      getModelDiscoveryCacheKey() ?? undefined
    if (
      isEqual(config.additionalModelOptionsCache, discovery.options) &&
      config.additionalModelOptionsCacheKey === additionalModelOptionsCacheKey
    ) {
      logForDebugging('[Bootstrap] Cache unchanged, skipping write')
      return
    }

    logForDebugging('[Bootstrap] Cache updated, persisting to disk')
    saveGlobalConfig(current => ({
      ...current,
      additionalModelOptionsCache: discovery.options,
      additionalModelOptionsCacheKey,
    }))
  } catch (error) {
    logError(error)
  }
}

async function fetchBootstrapCaches(): Promise<void> {
  try {
    const result = await fetchBootstrapAPI()
    if (!result || result.cacheKey !== getFirstPartyModelCacheKey()) return

    const { cacheKey, response } = result
    const config = getGlobalConfig()
    const clientData = response.client_data ?? null
    const autoCompactWindows = response.auto_compact_windows ?? null
    const additionalModelOptions = response.additional_model_options ?? []

    // Only persist if data actually changed — avoids a config write on every startup.
    if (
      isEqual(config.clientDataCache, clientData) &&
      isEqual(config.autoCompactWindowsCache, autoCompactWindows) &&
      config.bootstrapCacheKey === cacheKey &&
      isEqual(config.additionalModelOptionsCache, additionalModelOptions) &&
      config.additionalModelOptionsCacheKey === cacheKey
    ) {
      logForDebugging('[Bootstrap] Cache unchanged, skipping write')
      return
    }

    logForDebugging('[Bootstrap] Cache updated, persisting to disk')
    saveGlobalConfig(current => ({
      ...current,
      clientDataCache: clientData,
      autoCompactWindowsCache: autoCompactWindows,
      bootstrapCacheKey: cacheKey,
      additionalModelOptionsCache: additionalModelOptions,
      additionalModelOptionsCacheKey: cacheKey,
    }))
  } catch (error) {
    logError(error)
  }
}
