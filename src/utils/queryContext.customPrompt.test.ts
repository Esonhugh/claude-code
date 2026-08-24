import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('headless custom system prompt characterization', () => {
  test('treats an empty string as an explicit override and skips system context', () => {
    const source = readFileSync(new URL('./queryContext.ts', import.meta.url), 'utf8')

    expect(source).toContain('customSystemPrompt !== undefined')
    expect(source).toContain('customSystemPrompt !== undefined\n      ? Promise.resolve([])')
    expect(source).toContain(
      'customSystemPrompt !== undefined ? Promise.resolve({}) : getSystemContext()',
    )
  })
})
