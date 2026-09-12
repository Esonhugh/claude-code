import { describe, expect, test } from 'bun:test'
import { SettingsSchema } from './types.js'

describe('settings schema', () => {
  test('accepts only boolean Plan mode opt-in settings', () => {
    expect(SettingsSchema().safeParse({ planModeAvailable: 'true' }).success).toBe(false)
    expect(SettingsSchema().parse({ planModeAvailable: true }).planModeAvailable).toBe(true)
    expect(SettingsSchema().parse({ planModeAvailable: false }).planModeAvailable).toBe(false)
    expect(SettingsSchema().parse({}).planModeAvailable).toBeUndefined()
  })

  test('accepts explicit workflow enablement', () => {
    const result = SettingsSchema().safeParse({ enableWorkflows: true })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.enableWorkflows).toBe(true)
  })

  test('accepts minimal effort level', () => {
    const result = SettingsSchema().safeParse({ effortLevel: 'minimal' })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.effortLevel).toBe('minimal')
  })

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
