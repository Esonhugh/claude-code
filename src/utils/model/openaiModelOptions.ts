import axios from 'axios'
import { getOpenAIAuthInfo } from '../auth.js'
import { logForDebugging } from '../debug.js'
import { getClaudeCodeUserAgent } from '../userAgent.js'
import type { ModelOption } from './modelOptions.js'

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

export function getOpenAIModelOptions(): ModelOption[] {
  return FALLBACK_OPENAI_MODEL_OPTIONS
}

export async function fetchOpenAIModelOptions(): Promise<ModelOption[] | null> {
  const auth = getOpenAIAuthInfo()
  if (!auth) {
    logForDebugging('[OpenAI models] Skipped: no auth')
    return null
  }

  const endpoint = auth.isChatGPT
    ? 'https://chatgpt.com/backend-api/codex/models'
    : 'https://api.openai.com/v1/models'

  try {
    const response = await axios.get<OpenAIModelsResponse>(endpoint, {
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
      ...(auth.isChatGPT ? { params: { client_version: MACRO.VERSION } } : {}),
      timeout: 5000,
    })

    const data = response.data
    const options = parseOpenAIModelOptions(data)
    logForDebugging(`[OpenAI models] Fetched ${options.length} options`)
    return options.length > 0 ? options : null
  } catch (error) {
    logForDebugging(
      `[OpenAI models] Fetch failed: ${error instanceof Error ? error.constructor.name : 'unknown'}`,
    )
    return null
  }
}

export function parseOpenAIModelOptions(data: OpenAIModelsResponse): ModelOption[] {
  if (Array.isArray(data.models)) {
    return data.models
      .filter(model => model.supported_in_api !== false)
      .filter(model => typeof model.slug === 'string' && model.slug.length > 0)
      .filter(model => isOpenAIListableModel(model.slug as string))
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
    .filter(model => isOpenAIListableModel(model.id as string))
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
