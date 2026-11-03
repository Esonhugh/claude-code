import { describe, expect, it } from 'bun:test'
import { usageByModel } from './Settings'

describe('usageByModel', () => {
  it('merges ids of one model into one row, like /cost', () => {
    const rows = usageByModel({
      opus: { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 100, cacheCreationInputTokens: 5, canonicalModel: 'claude-opus-5-5' },
      'claude-opus-5-5': { inputTokens: 20, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, canonicalModel: 'claude-opus-5-5' },
      'deepseek-v4.1-flash': { inputTokens: 3, outputTokens: 4 },
    })
    expect(rows).toEqual([
      ['claude-opus-5-5', { inputTokens: 30, outputTokens: 3, cacheReadInputTokens: 100, cacheCreationInputTokens: 5, costUSD: 0 }],
      ['deepseek-v4.1-flash', { inputTokens: 3, outputTokens: 4, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 }],
    ])
  })
})
