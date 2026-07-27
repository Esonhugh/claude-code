import { describe, expect, test } from 'bun:test'
import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { calculateUSDCost } from './modelCost.js'

const MODEL = 'claude-sonnet-4-5-20250929'

describe('calculateUSDCost', () => {
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
