import { describe, expect, it } from 'bun:test'
import type { ModelOption } from '../protocol'
import { modelName } from './Message'

const models: ModelOption[] = [
  {
    value: 'default',
    displayName: 'Default (recommended)',
    resolvedModel: 'claude-opus-5-5',
    description: 'Use the default model (currently Opus 5.5) · $4/$20 per Mtok',
  },
  {
    value: 'opus',
    displayName: 'Opus',
    resolvedModel: 'claude-opus-5-5',
    description: 'Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok',
  },
  { value: 'claude-custom-1', displayName: 'Custom model' },
]

describe('modelName', () => {
  it('names a resolved model id by the models list, not the raw id', () => {
    expect(modelName('claude-opus-5-5', models)).toBe('Opus 5.5')
    expect(modelName('opus', models)).toBe('Opus 5.5')
    expect(modelName('claude-custom-1', models)).toBe('Custom model')
    expect(modelName('default', models)).toBe('Default (recommended)')
  })

  it('falls back to a readable label without a models list', () => {
    expect(modelName('claude-sonnet-5-5', [])).toBe('Sonnet 5.5')
    expect(modelName(undefined, models)).toBeUndefined()
  })
})
