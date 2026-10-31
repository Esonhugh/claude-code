import { expect, test } from 'bun:test'

import { getModelUsage, resetCostState } from './bootstrap/state.js'
import { addToTotalSessionCost } from './cost-tracker.js'

const base = {
  input_tokens: 2,
  output_tokens: 10,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 900,
}

test('modelUsage splits cache writes by lifetime like SDK 0.3.311', () => {
  resetCostState()
  addToTotalSessionCost(0, { ...base, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 800 } } as never, 'claude-haiku-5-5')
  addToTotalSessionCost(0, { ...base, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 900 } } as never, 'claude-haiku-5-5')
  const usage = getModelUsage()['claude-haiku-5-5']!
  expect(usage.cacheCreationInputTokens).toBe(1800)
  expect(usage.cacheCreationEphemeral5mInputTokens).toBe(100)
  expect(usage.cacheCreationEphemeral1hInputTokens).toBe(1700)
})

test('a response without cache lifetimes adds to neither split', () => {
  resetCostState()
  addToTotalSessionCost(0, base as never, 'claude-haiku-5-5')
  const usage = getModelUsage()['claude-haiku-5-5']!
  expect(usage.cacheCreationEphemeral5mInputTokens).toBeUndefined()
  expect(usage.cacheCreationEphemeral1hInputTokens).toBeUndefined()
})
