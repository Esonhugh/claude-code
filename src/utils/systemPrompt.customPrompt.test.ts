import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('interactive custom system prompt characterization', () => {
  test('currently treats an empty custom prompt as absent', () => {
    const source = readFileSync(new URL('./systemPrompt.ts', import.meta.url), 'utf8')

    expect(source).toContain('customSystemPrompt\n        ? [customSystemPrompt]\n        : defaultSystemPrompt')
  })
})
