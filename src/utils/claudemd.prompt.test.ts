import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('CLAUDE.md prompt boundary', () => {
  test('scopes project instructions below mode and runtime enforcement', () => {
    const source = readFileSync(new URL('./claudemd.ts', import.meta.url), 'utf8')

    expect(source).toContain('override default task behavior')
    expect(source).toContain('do not override active permission modes')
    expect(source).toContain('runtime safety enforcement')
    expect(source).not.toContain('OVERRIDE any default behavior')
  })
})
