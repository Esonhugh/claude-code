import { describe, expect, it } from 'bun:test'
import type { Block, Item, ModelOption } from '../protocol'
import { imageTarget, joinTurns, modelName, relativeTo, stepActions, turnSegments } from './Message'

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

  it('keeps a file edit out of the folded steps', () => {
    const blocks = [think, tool('read', 'Read'), tool('edit', 'Edit'), think, tool('ls'), text('done')]
    expect(turnSegments(blocks, () => false, i => i === 2)).toEqual([
      { kind: 'steps', at: [0, 1] },
      { kind: 'step', at: [2] },
      { kind: 'steps', at: [3, 4] },
      { kind: 'text', at: [5] },
    ])
  })
})

describe('stepActions', () => {
  const call = (name: string, input: Record<string, unknown>): Extract<Block, { kind: 'tool' }> => ({ kind: 'tool', id: name + JSON.stringify(input), name, input: JSON.stringify(input) })
  const t = (key: string, vars?: Record<string, string>) => `${key}:${Object.values(vars ?? {}).join(',')}`

  it('says what a run of tools did', () => {
    expect(
      stepActions(
        [
          call('Read', { file_path: '/a' }),
          call('Read', { file_path: '/b' }),
          call('Read', { file_path: '/a' }),
          call('Grep', { pattern: 'x' }),
          call('Bash', { command: 'bun test\nmore' }),
          call('TodoWrite', { todos: [] }),
        ],
        t as never,
      ),
    ).toEqual(['stepsRead:2', 'stepsSearched:1', 'stepsRanOne:bun test', 'TodoWrite'])
    expect(stepActions([call('Bash', { command: 'a' }), call('Bash', { command: 'b' })], t as never)).toEqual(['stepsRan:2'])
  })
})

describe('handback report', () => {
  it('spins only while the turn streams: a saved report has no result yet still finished', async () => {
    const react = await import('react')
    ;(globalThis as { React?: unknown }).React ??= react
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { Message } = await import('./Message')
    const item: Item = {
      kind: 'assistant',
      id: 'a1',
      streamed: false,
      blocks: [{ kind: 'tool', id: 't1', name: 'SubagentHandback', input: JSON.stringify({ message: 'All done.' }) }],
    }
    const render = (streaming: boolean) =>
      renderToStaticMarkup(react.createElement(Message, { item, t: ((key: string) => key) as never, streaming }))
    expect(render(false)).toContain('All done.')
    expect(render(false)).not.toContain('class="spin"')
    expect(render(true)).toContain('class="spin"')
  })
})

describe('imageTarget', () => {
  it('names the image and the start of its message, with mentions as file names', () => {
    expect(imageTarget('Fix   this\n@/a/b/readme.md and @"/x y/z.png"', 1)).toBe(
      'image 2 of my message "Fix this readme.md and z.png"',
    )
    expect(imageTarget('', 0)).toBe('image 1 of my message')
    expect(imageTarget('x'.repeat(50), 0)).toBe(`image 1 of my message "${'x'.repeat(40)}…"`)
  })
})
