import { describe, expect, it } from 'bun:test'
import type { Block, Item, ModelOption } from '../protocol'
import { joinTurns, modelName, relativeTo, turnSegments } from './Message'

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

describe('one header per turn', () => {
  const reply = (id: string, ...blocks: Block[]): Item => ({ kind: 'assistant', id, streamed: false, blocks })
  const text = (t: string): Block => ({ kind: 'text', text: t })
  const think: Block = { kind: 'thinking', text: 'hm', ms: 2000 }
  const tool = (id: string, name = 'Bash'): Block => ({ kind: 'tool', id, name, input: '{}' })

  it('joins the API messages of a turn into one message', () => {
    const items: Item[] = [
      { kind: 'user', id: 'u1', text: 'hi' },
      reply('a1', think, tool('t1')),
      reply('a2', think, text('done')),
      { kind: 'user', id: 'u2', text: 'again' },
      reply('a3', text('third')),
    ]
    const turns = joinTurns(items)
    expect(turns.map(x => x.ids)).toEqual([['u1'], ['a1', 'a2'], ['u2'], ['a3']])
    expect(turns[1]!.item).toMatchObject({ id: 'a1', blocks: [think, tool('t1'), think, text('done')] })
    // A task notice under a1 ends the turn there.
    expect(joinTurns(items, id => id === 'a1').map(x => x.ids)).toContainEqual(['a1'])
  })

  it('folds runs of thinking and tools into steps, keeps single steps and task cards apart', () => {
    const blocks = [think, text('a'), think, tool('t1'), think, tool('agent', 'Agent'), tool('agent2', 'Agent'), think, text('b'), undefined]
    expect(turnSegments(blocks, i => i === 5 || i === 6)).toEqual([
      { kind: 'step', at: [0] },
      { kind: 'text', at: [1] },
      { kind: 'steps', at: [2, 3, 4] },
      { kind: 'cards', at: [5, 6] },
      { kind: 'step', at: [7] },
      { kind: 'text', at: [8] },
    ])
  })
})
