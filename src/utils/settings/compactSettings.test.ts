import { describe, expect, test } from 'bun:test'
import { SettingsSchema } from './types.js'

describe('settings schema', () => {
  test('accepts explicit terminal renderers and rejects unknown modes', () => {
    expect(SettingsSchema().parse({ tui: 'fullscreen' }).tui).toBe('fullscreen')
    expect(SettingsSchema().parse({ tui: 'default' }).tui).toBe('default')
    expect(SettingsSchema().safeParse({ tui: 'split' }).success).toBe(false)
  })

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

  test('describes exclusions for instruction files rather than two basenames', () => {
    const description = SettingsSchema().shape.claudeMdExcludes.description

    expect(description).toContain('instruction files')
    expect(description).toContain(
      'AGENTS.md, CLAUDE.md, CLAUDE.local.md, rules, and imported files',
    )
    expect(description).toContain('**/AGENTS.md')
    expect(description).toContain('Managed/policy files cannot be excluded')
  })

  test('accepts minimal effort level', () => {
    const result = SettingsSchema().safeParse({ effortLevel: 'minimal' })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.effortLevel).toBe('minimal')
  })

  test('validates the auto compact window used by production compaction', () => {
    expect(SettingsSchema().parse({ autoCompactWindow: 150_000 }).autoCompactWindow).toBe(150_000)
    expect(SettingsSchema().safeParse({ autoCompactWindow: 99_999 }).success).toBe(false)
    expect(SettingsSchema().safeParse({ autoCompactWindow: 1_000_001 }).success).toBe(false)
    expect(SettingsSchema().safeParse({ autoCompactWindow: 150_000.5 }).success).toBe(false)
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
