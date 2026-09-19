import { describe, expect, test } from 'bun:test'
import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import {
  calculateUSDCost,
  getModelCosts,
  getModelPricingString,
} from './modelCost.js'

const MODEL = 'claude-sonnet-4-5-20250929'

describe('calculateUSDCost', () => {
  test.each([
    ['claude-opus-5', 5, 25, 6.25, 0.5],
    ['claude-sonnet-5', 2, 10, 2.5, 0.2],
    ['gpt-5.6-sol', 4, 20, 4, 0.4],
    ['gpt-6-astra', 10, 50, 10, 1],
    ['gpt-5.6-terra', 2, 12, 2, 0.2],
    ['gpt-5.6-luna', 0.2, 1.2, 0.2, 0.02],
  ] as const)(
    '%s uses confirmed token and cache prices',
    (model, input, output, cacheWrite, cacheRead) => {
      const usage = {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_creation_input_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
      } as Usage
      expect(getModelCosts(model, usage)).toMatchObject({
        inputTokens: input,
        outputTokens: output,
        promptCacheWriteTokens: cacheWrite,
        promptCacheReadTokens: cacheRead,
      })
      expect(calculateUSDCost(model, usage)).toBeCloseTo(
        input + output + cacheWrite + cacheRead,
      )
      expect(getModelPricingString(model)).toBeDefined()
    },
  )

  test('client context markers do not turn a known OpenAI price into an estimate', () => {
    expect(getModelPricingString('gpt-5.6-sol[1m]')).toBe('$4/$20 per Mtok')
    const usage = { input_tokens: 1_000_000, output_tokens: 0 } as Usage
    expect(calculateUSDCost('gpt-5.6-sol[1m]', usage)).toBe(4)
  })

  // Reproduces the crash observed in the non-streaming fallback path:
  // "undefined is not an object (evaluating '$.input_tokens')" — a fallback
  // response with a missing usage field reaches tokensToUSDCost.
  test('returns 0 for missing usage instead of throwing', () => {
    expect(() =>
      calculateUSDCost(MODEL, undefined as unknown as Usage),
    ).not.toThrow()
    expect(calculateUSDCost(MODEL, undefined as unknown as Usage)).toBe(0)
  })

  test('still computes a positive cost for a normal usage', () => {
    const usage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    } as unknown as Usage
    expect(calculateUSDCost(MODEL, usage)).toBeGreaterThan(0)
  })
})
