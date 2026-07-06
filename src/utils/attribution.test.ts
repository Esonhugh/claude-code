import { describe, expect, test } from 'bun:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

describe('attribution defaults', () => {
  test('does not include commit or PR attribution when attribution is not configured', async () => {
    const { getAttributionTexts, getEnhancedPRAttribution } = await import(
      './attribution.js'
    )

    expect(getAttributionTexts()).toEqual({ commit: '', pr: '' })
    expect(
      await getEnhancedPRAttribution(() => ({ attribution: undefined }) as never),
    ).toBe('')
  })
})
