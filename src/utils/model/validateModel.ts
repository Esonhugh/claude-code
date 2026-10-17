// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { MODEL_ALIASES } from './aliases.js'
import { isModelAllowed } from './modelAllowlist.js'
import { getAPIProvider } from './providers.js'
import { sideQuery } from '../sideQuery.js'
import {
  NotFoundError,
  APIError,
  APIConnectionError,
  AuthenticationError,
} from '@anthropic-ai/sdk'
import { getModelStrings } from './modelStrings.js'
import { withTimeout } from '../sleep.js'
import { hasServedModel } from './servedModelCatalog.js'

export type ModelValidationErrorCode =
  | 'catalog_unknown'
  | 'restricted_by_org'
  | 'auth_failed'
  | 'check_failed'

export type ModelValidationResult = {
  valid: boolean
  error?: string
  errorCode?: ModelValidationErrorCode
}

// Cache valid models to avoid repeated API calls
const validModelCache = new Map<string, boolean>()

/**
 * Validates a model by attempting an actual API call.
 */
export async function validateModel(
  model: string,
  options: { deadlineMs?: number } = {},
): Promise<ModelValidationResult> {
  const normalizedModel = model.trim()

  // Empty model is invalid
  if (!normalizedModel) {
    return { valid: false, error: 'Model name cannot be empty' }
  }

  // Check against availableModels allowlist before any API call
  if (!isModelAllowed(normalizedModel)) {
    return {
      valid: false,
      error: `Model '${normalizedModel}' is not in the list of available models`,
      errorCode: 'restricted_by_org',
    }
  }

  // Check if it's a known alias (these are always valid)
  const lowerModel = normalizedModel.toLowerCase()
  if ((MODEL_ALIASES as readonly string[]).includes(lowerModel)) {
    return { valid: true }
  }

  // Check if it matches ANTHROPIC_CUSTOM_MODEL_OPTION (pre-validated by the user)
  if (normalizedModel === process.env.ANTHROPIC_CUSTOM_MODEL_OPTION) {
    return { valid: true }
  }

  // A Claude.ai OAuth served catalog is authoritative for models advertised by
  // the organization, including models this binary does not compile into its
  // static picker. Other providers and auth modes return false here.
  if (hasServedModel(normalizedModel)) {
    return { valid: true }
  }

  // Check cache first
  if (validModelCache.has(normalizedModel)) {
    return { valid: true }
  }

  const controller = new AbortController()
  const deadlineError = `Couldn't confirm model "${normalizedModel}" with the API. Try again, or run /model to see available models.`
  // Try to make an actual API call with minimal parameters.
  try {
    const probe = sideQuery({
      model: normalizedModel,
      max_tokens: 1,
      maxRetries: 0,
      signal: controller.signal,
      querySource: 'model_validation',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Hi',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    })

    if (options.deadlineMs === undefined) await probe
    else await withTimeout(probe, options.deadlineMs, deadlineError)

    // If we got here, the model is valid
    validModelCache.set(normalizedModel, true)
    return { valid: true }
  } catch (error) {
    if (error instanceof Error && error.message === deadlineError) {
      controller.abort()
      return { valid: false, error: deadlineError, errorCode: 'check_failed' }
    }
    return handleValidationError(error, normalizedModel)
  }
}

function handleValidationError(
  error: unknown,
  modelName: string,
): ModelValidationResult {
  // NotFoundError (404) means the model doesn't exist
  if (error instanceof NotFoundError) {
    const fallback = get3PFallbackSuggestion(modelName)
    const suggestion = fallback ? `. Try '${fallback}' instead` : ''
    return {
      valid: false,
      error: `Model '${modelName}' not found${suggestion}`,
      errorCode: 'catalog_unknown',
    }
  }

  // For other API errors, provide context-specific messages
  if (error instanceof APIError) {
    if (error instanceof AuthenticationError) {
      return {
        valid: false,
        error: 'Authentication failed. Please check your API credentials.',
        errorCode: 'auth_failed',
      }
    }

    if (error instanceof APIConnectionError) {
      return {
        valid: false,
        error: 'Network error. Please check your internet connection.',
        errorCode: 'check_failed',
      }
    }

    // Check error body for model-specific errors
    const errorBody = error.error as unknown
    if (
      errorBody &&
      typeof errorBody === 'object' &&
      'type' in errorBody &&
      errorBody.type === 'not_found_error' &&
      'message' in errorBody &&
      typeof errorBody.message === 'string' &&
      errorBody.message.includes('model:')
    ) {
      return { valid: false, error: `Model '${modelName}' not found`, errorCode: 'catalog_unknown' }
    }

    // Generic API error
    const body = error.error as { error?: { message?: unknown }; message?: unknown } | undefined
    const detail = body?.error?.message ?? body?.message
    const message = typeof detail === 'string' && error.status !== undefined
      ? `${error.status} ${detail}`
      : error.message
    const retryable = error.status === undefined || error.status === 408 || error.status === 429 || error.status >= 500
    return {
      valid: false,
      error: `API error: ${message.replace(/[.!?\u2026]+$/, '')} · model not changed`,
      ...(retryable && { errorCode: 'check_failed' as const }),
    }
  }

  // For unknown errors, be safe and reject
  const errorMessage = error instanceof Error ? error.message : String(error)
  return {
    valid: false,
    error: `Unable to validate model: ${errorMessage}`,
    errorCode: 'check_failed',
  }
}

// @[MODEL LAUNCH]: Add a fallback suggestion chain for the new model → previous version
/**
 * Suggest a fallback model for 3P users when the selected model is unavailable.
 */
function get3PFallbackSuggestion(model: string): string | undefined {
  if (getAPIProvider() === 'firstParty') {
    return undefined
  }
  const lowerModel = model.toLowerCase()
  if (lowerModel.includes('opus-4-6') || lowerModel.includes('opus_4_6')) {
    return getModelStrings().opus41
  }
  if (lowerModel.includes('sonnet-4-6') || lowerModel.includes('sonnet_4_6')) {
    return getModelStrings().sonnet45
  }
  if (lowerModel.includes('sonnet-4-5') || lowerModel.includes('sonnet_4_5')) {
    return getModelStrings().sonnet40
  }
  return undefined
}
