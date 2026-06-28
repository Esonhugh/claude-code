import { describe, expect, test } from 'bun:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

describe('getAttributionHeader', () => {
  test('CLAUDE_CODE_ATTRIBUTION_HEADER=1 forces attribution on', async () => {
    const previous = process.env.CLAUDE_CODE_ATTRIBUTION_HEADER
    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '1'

    try {
      const { getAttributionHeader } = await import('./system.js')

      expect(getAttributionHeader('abcde')).toContain(
        'x-anthropic-billing-header:',
      )
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER
      } else {
        process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = previous
      }
    }
  })
})
