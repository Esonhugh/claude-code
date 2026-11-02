import { expect, test } from 'bun:test'
import type { Message } from '../types/message.js'
import { getPromptCacheFacts } from './promptCacheFacts.js'

const reply = (timestamp: string, usage: object): Message =>
  ({
    type: 'assistant',
    timestamp,
    message: { model: 'claude-opus-5-5', usage },
  }) as unknown as Message

test('reports the last response window, its age against the TTL and the re-cache cost', () => {
  const now = Date.parse('2026-10-30T12:10:00Z')
  const messages = [
    reply('2026-10-30T12:00:00Z', {
      input_tokens: 10,
      cache_read_input_tokens: 90_000,
      cache_creation_input_tokens: 9_990,
      output_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 9_990, ephemeral_1h_input_tokens: 0 },
    }),
  ]
  expect(getPromptCacheFacts(messages, undefined, now)).toEqual({
    secondsSinceLastResponse: 600,
    contextTokens: 100_000,
    cacheTtl: '5m',
    promptCacheLikelyExpired: true,
    estimatedCacheWriteUsd: 0.5,
  })
  const hour = [
    reply('2026-10-30T12:00:00Z', {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 5 },
    }),
  ]
  expect(getPromptCacheFacts(hour, undefined, now)).toMatchObject({
    cacheTtl: '1h',
    promptCacheLikelyExpired: false,
    estimatedCacheWriteUsd: 8,
  })
  expect(getPromptCacheFacts([], undefined, now)).toBeUndefined()
})
