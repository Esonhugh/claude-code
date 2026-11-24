import { expect, test } from 'bun:test'

import { getAgentSpend, getTotalCostUSD, resetCostState } from './bootstrap/state.js'
import { addToTotalSessionCost } from './cost-tracker.js'

const usage = (input: number, output: number, cache?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number }) =>
  ({
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: cache ? cache.ephemeral_5m_input_tokens + cache.ephemeral_1h_input_tokens : 0,
    ...(cache && { cache_creation: cache }),
  }) as never

// Official 2.1.329: $.agent.list()'s usage and cost are the agent's own part
// of /cost, one usage entry per model that answered.
test('a credited request adds to the agent spend by answering model', () => {
  resetCostState()
  addToTotalSessionCost(0.5, usage(10, 5), 'claude-opus-5-5', { agentId: 'a1', answeredModel: 'claude-opus-5-5' })
  addToTotalSessionCost(0.25, usage(1, 2, { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 0 }), 'claude-opus-5-5', { agentId: 'a1', answeredModel: 'claude-opus-5-5' })
  addToTotalSessionCost(0.125, usage(4, 4), 'claude-opus-5-5', { agentId: 'a1', answeredModel: 'claude-sonnet-5-5' })
  addToTotalSessionCost(1, usage(100, 100), 'claude-opus-5-5')
  expect(getAgentSpend('a1')).toEqual({
    usage: [
      { model: 'claude-opus-5-5', input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 3, ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 0 },
      { model: 'claude-sonnet-5-5', input_tokens: 4, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ],
    costUSD: 0.875,
    hasUnknownModelCost: false,
  })
  expect(getTotalCostUSD()).toBe(1.875)
})

test('an unpriced model marks the agent spend, and a cost reset clears it', () => {
  resetCostState()
  addToTotalSessionCost(0, usage(1, 1), 'gateway-private-model', { agentId: 'a2' })
  expect(getAgentSpend('a2')).toMatchObject({ costUSD: 0, hasUnknownModelCost: true, usage: [{ model: 'gateway-private-model' }] })
  resetCostState()
  expect(getAgentSpend('a2')).toBeUndefined()
})
