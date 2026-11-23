import { expect, test } from 'bun:test'

import {
  getModelUsage,
  resetCostState,
  takeModelUsageSinceLastResult,
  trackModelUsageSinceLastResult,
} from './bootstrap/state.js'
import { addToTotalSessionCost } from './cost-tracker.js'

const usage = (input: number, output: number) =>
  ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) as never

// Official 2.1.329: result.model_usage_since_last_result holds each model's
// usage since the previous result, in the shape of modelUsage, once a
// stream-json host tracks it.
test('usage since the last result restarts at each result', () => {
  resetCostState()
  expect(takeModelUsageSinceLastResult()).toBeUndefined()
  addToTotalSessionCost(0.5, usage(1, 1), 'claude-haiku-5-5')
  trackModelUsageSinceLastResult()

  addToTotalSessionCost(0.25, usage(10, 2), 'claude-haiku-5-5')
  addToTotalSessionCost(1, usage(100, 20), 'claude-opus-5-5')
  const first = takeModelUsageSinceLastResult()!
  expect(first['claude-haiku-5-5']).toMatchObject({ inputTokens: 10, outputTokens: 2, costUSD: 0.25 })
  expect(first['claude-opus-5-5']).toMatchObject({ inputTokens: 100, outputTokens: 20, costUSD: 1 })
  expect(first['claude-haiku-5-5']).not.toBe(getModelUsage()['claude-haiku-5-5'])
  expect(getModelUsage()['claude-haiku-5-5']).toMatchObject({ inputTokens: 11, outputTokens: 3 })

  expect(takeModelUsageSinceLastResult()).toEqual({})
  addToTotalSessionCost(0, usage(5, 5), 'claude-haiku-5-5')
  expect(Object.keys(takeModelUsageSinceLastResult()!)).toEqual(['claude-haiku-5-5'])
})
