import { describe, expect, it } from 'bun:test'
import type { ModelOption } from '../protocol'
import { modelName, relativeTo } from './Message'

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

describe('relativeTo', () => {
  it('drops the chat folder from a path under it, with either separator', () => {
    expect(relativeTo('/home/u/workspace/edit.txt', '/home/u/workspace')).toBe('edit.txt')
    expect(relativeTo('C:\\Users\\u\\workspace\\edit.txt', 'C:\\Users\\u\\workspace')).toBe('edit.txt')
    expect(relativeTo('C:\\Users\\u\\workspace\\a\\b.txt', 'C:\\Users\\u\\workspace\\')).toBe('a\\b.txt')
    expect(relativeTo('C:\\Users\\u\\workspace2\\x.txt', 'C:\\Users\\u\\workspace')).toBe('C:\\Users\\u\\workspace2\\x.txt')
  })
})
