import { createHash } from 'node:crypto'
import axios from 'axios'
import { getAnthropicApiKey, getOpenAIAuthInfo } from '../auth.js'
import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'
import { getClaudeCodeUserAgent } from '../userAgent.js'
import type { ModelOption } from './modelOptions.js'
import { getAPIProvider } from './providers.js'

const FALLBACK_OPENAI_MODEL_OPTIONS: ModelOption[] = [
  {
    value: 'gpt-5.5',
    label: 'GPT-5.5',
    description: 'Frontier model for complex coding, research, and real-world work.',
  },
  {
    value: 'gpt-5.4-mini',
    label: 'GPT-5.4-Mini',
    description: 'Small, fast, and cost-efficient model for simpler coding tasks.',
  },
]

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
  defaultDescription?: string
}

export function getOpenAIModelOptions(): ModelOption[] {
  return FALLBACK_OPENAI_MODEL_OPTIONS
}

export function isModelDiscoveryEnabled(): boolean {
  return (
    getAPIProvider() === 'openai' ||
    (getAPIProvider() === 'firstParty' &&
      isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY) &&
      Boolean(process.env.ANTHROPIC_BASE_URL))
  )
}

export function getModelDiscoveryCacheKey(): string | null {
  if (getAPIProvider() === 'openai') {
    const auth = getOpenAIAuthInfo()
    if (!auth) return null
    if (auth.isChatGPT) {
      return `openai:chatgpt:${auth.accountId?.trim() || credentialIdentity(auth.accessToken)}`
    }
    return `openai:${getModelsBaseURL(process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1')}:api:${credentialIdentity(auth.accessToken)}`
  }

  if (!isModelDiscoveryEnabled()) return null
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN
  const apiKey = authToken ? null : getAnthropicApiKey()
  if (!authToken && !apiKey) return null
  const credentialType = authToken ? 'auth-token' : 'api-key'
  return `anthropic:${getModelsBaseURL(process.env.ANTHROPIC_BASE_URL!)}:${credentialType}:${credentialIdentity(authToken ?? apiKey!)}`
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
  if (getAPIProvider() === 'openai') {
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
              ...(auth.accountId
                ? { 'chatgpt-account-id': auth.accountId }
                : {}),
            }
          : {}),
      },
      ...(auth.isChatGPT
        ? { params: { client_version: MACRO.VERSION } }
        : {}),
      parseOptions: {
        includeUnknownModels: !auth.isChatGPT && Boolean(customBaseURL),
      },
    }
  }

  if (!isModelDiscoveryEnabled()) return null

  const authToken = process.env.ANTHROPIC_AUTH_TOKEN
  const apiKey = authToken ? null : getAnthropicApiKey()
  if (!authToken && !apiKey) {
    logForDebugging('[Model discovery] Skipped: no Anthropic gateway auth')
    return null
  }

  return {
    cacheKey: `anthropic:${getModelsBaseURL(process.env.ANTHROPIC_BASE_URL!)}:${authToken ? 'auth-token' : 'api-key'}:${credentialIdentity(authToken ?? apiKey!)}`,
    endpoint: getModelsEndpoint(process.env.ANTHROPIC_BASE_URL!),
    headers: {
      ...(authToken
        ? { Authorization: `Bearer ${authToken}` }
        : { 'x-api-key': apiKey! }),
      Accept: 'application/json',
      'anthropic-version': '2023-06-01',
      'User-Agent': getClaudeCodeUserAgent(),
    },
    parseOptions: {
      includeUnknownModels: true,
      defaultDescription: 'From gateway',
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
          : (options.defaultDescription ?? 'OpenAI model')
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
        : (options.defaultDescription ?? 'OpenAI model')
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
