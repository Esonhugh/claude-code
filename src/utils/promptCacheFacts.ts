import { getCacheControl } from '../services/api/claude.js'
import type { Message } from '../types/message.js'
import { SYNTHETIC_MODEL } from './messages.js'
import { getModelCosts } from './modelCost.js'

export type PromptCacheFacts = {
  secondsSinceLastResponse: number
  contextTokens: number
  cacheTtl: '5m' | '1h'
  promptCacheLikelyExpired: boolean
  estimatedCacheWriteUsd: number
}

// What official 2.1.311 reports about re-sending the conversation: the last
// response's whole window (input + cache read + cache write + output), how old
// it is against the cache TTL, and the cost of writing it to the cache again.
export function getPromptCacheFacts(
  messages: readonly Message[],
  model: string | undefined,
  now: number = Date.now(),
): PromptCacheFacts | undefined {
  const last = messages.findLast(
    m =>
      m.type === 'assistant' &&
      m.message.model !== SYNTHETIC_MODEL &&
      m.message.usage !== undefined,
  )
  if (last?.type !== 'assistant') return undefined
  const repliedAt = Date.parse(last.timestamp)
  if (Number.isNaN(repliedAt)) return undefined
  const usage = last.message.usage
  const contextTokens =
    usage.input_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    usage.output_tokens
  const created = usage.cache_creation
  const cacheTtl: '5m' | '1h' = created?.ephemeral_1h_input_tokens
    ? '1h'
    : created?.ephemeral_5m_input_tokens
      ? '5m'
      : getCacheControl({ querySource: 'repl_main_thread' }).ttl === '1h'
        ? '1h'
        : '5m'
  const secondsSinceLastResponse = Math.max(0, Math.round((now - repliedAt) / 1000))
  const costs = getModelCosts(model ?? last.message.model, usage as Parameters<typeof getModelCosts>[1])
  // A 1h cache write costs 2x input; the 5m rate is the catalog's cache-write price.
  const perMillion =
    cacheTtl === '1h' ? costs.inputTokens * 2 : costs.promptCacheWriteTokens
  return {
    secondsSinceLastResponse,
    contextTokens,
    cacheTtl,
    promptCacheLikelyExpired:
      secondsSinceLastResponse >= (cacheTtl === '1h' ? 3600 : 300),
    estimatedCacheWriteUsd:
      Math.round((contextTokens / 1_000_000) * perMillion * 1e4) / 1e4,
  }
}
