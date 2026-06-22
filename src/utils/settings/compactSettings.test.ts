import { describe, expect, test } from 'bun:test'
import { SettingsSchema } from './types.js'

describe('compact settings schema', () => {
  test('accepts codex compact mode with options', () => {
    const result = SettingsSchema().safeParse({
      compact: {
        mode: 'codex',
        codex: {
          retainedUserMessageTokens: 20000,
          keepPostCompactAttachments: false,
        },
      },
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.compact?.mode).toBe('codex')
    expect(result.data.compact?.codex?.retainedUserMessageTokens).toBe(20000)
    expect(result.data.compact?.codex?.keepPostCompactAttachments).toBe(false)
  })

  test('rejects unsupported compact mode', () => {
    const result = SettingsSchema().safeParse({
      compact: {
        mode: 'openai',
      },
    })

    expect(result.success).toBe(false)
  })
})
