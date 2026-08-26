import { describe, expect, test } from 'bun:test'
import { SDKControlGetSettingsResponseSchema } from './controlSchemas.js'
import { AgentDefinitionSchema, ModelInfoSchema } from './coreSchemas.js'

describe('SDK effort schemas', () => {
  test('accept minimal in model capabilities', () => {
    const result = ModelInfoSchema().safeParse({
      value: 'gpt-5.5',
      displayName: 'GPT 5.5',
      description: 'Test model',
      supportsEffort: true,
      supportedEffortLevels: ['minimal'],
    })

    expect(result.success).toBe(true)
  })

  test('accept minimal in resolved settings', () => {
    const result = SDKControlGetSettingsResponseSchema().safeParse({
      effective: {},
      sources: [],
      applied: { model: 'gpt-5.5', effort: 'minimal' },
    })

    expect(result.success).toBe(true)
  })

  test('accept minimal in agent definitions', () => {
    const result = AgentDefinitionSchema().safeParse({
      description: 'Test agent',
      prompt: 'Test prompt',
      effort: 'minimal',
    })

    expect(result.success).toBe(true)
  })
})
