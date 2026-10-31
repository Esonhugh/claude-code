import { expect, test } from 'bun:test'

import { nextThinkingEstimate } from './thinkingTokenEstimate.js'

test('thinking_delta estimated_tokens adds up per block like 2.1.311', () => {
  let s = nextThinkingEstimate(9, { type: 'content_block_start' })
  expect(s).toEqual({ estimate: 0, emission: null })
  s = nextThinkingEstimate(s.estimate, { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '', estimated_tokens: 50 } })
  expect(s).toEqual({ estimate: 50, emission: { estimatedTokens: 50, estimatedTokensDelta: 50 } })
  s = nextThinkingEstimate(s.estimate, { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '', estimated_tokens: 200 } })
  expect(s.emission).toEqual({ estimatedTokens: 250, estimatedTokensDelta: 200 })
  // A null estimate with no text emits nothing.
  s = nextThinkingEstimate(s.estimate, { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '', estimated_tokens: null } })
  expect(s).toEqual({ estimate: 250, emission: null })
  // The signature raises the estimate to its size when larger.
  s = nextThinkingEstimate(s.estimate, { type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'x'.repeat(2032) } })
  expect(s.emission).toEqual({ estimatedTokens: 381, estimatedTokensDelta: 131 })
})

test('visible thinking text counts four characters per token', () => {
  const s = nextThinkingEstimate(0, { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'abcdefghi' } })
  expect(s.emission).toEqual({ estimatedTokens: 3, estimatedTokensDelta: 3 })
  expect(nextThinkingEstimate(7, { type: 'message_delta' })).toEqual({ estimate: 7, emission: null })
})
