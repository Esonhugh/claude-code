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

describe('attribution settings are not an entry point', () => {
  test('attribution and includeCoAuthoredBy in settings add nothing', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'attr-'))
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ attribution: { commit: 'Co-Authored-By: X <x@y>', pr: 'made by X' }, includeCoAuthoredBy: true }),
    )
    const previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = dir
    const { resetSettingsCache } = await import('./settings/settingsCache.js')
    resetSettingsCache()
    try {
      const { getAttributionTexts, getEnhancedPRAttribution } = await import('./attribution.js')
      expect(getAttributionTexts()).toEqual({ commit: '', pr: '' })
      expect(await getEnhancedPRAttribution(() => ({ attribution: undefined }) as never)).toBe('')
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previous
      resetSettingsCache()
    }
  })
})
