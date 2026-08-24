import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('interactive custom prompt context characterization', () => {
  test('currently builds default and system context before applying custom prompt', () => {
    const source = readFileSync(new URL('./REPL.tsx', import.meta.url), 'utf8')

    expect(source).toContain('getSystemPrompt(\n            freshTools,')
    expect(source).toContain('getSystemContext(),')
    expect(source).toContain('buildEffectiveSystemPrompt({')
    expect(source).toContain('customSystemPrompt,\n        defaultSystemPrompt,')
  })
})
