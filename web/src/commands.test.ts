import { describe, expect, it } from 'bun:test'
import { filterCommands, moveSelection, paletteQuery, type SlashCommand } from './commands'

const cmd = (name: string, aliases?: string[]): SlashCommand => ({
  name,
  description: `${name} description`,
  argumentHint: '',
  ...(aliases && { aliases }),
})

const commands = [
  cmd('simplify'),
  cmd('compact'),
  cmd('context'),
  cmd('usage', ['cost', 'stats']),
  cmd('color'),
  cmd('mcp'),
]

describe('paletteQuery', () => {
  it('opens only while the draft is a bare /name', () => {
    expect(paletteQuery('/')).toBe('')
    expect(paletteQuery('/Co')).toBe('co')
    expect(paletteQuery('/usage ')).toBeUndefined()
    expect(paletteQuery('/usage now')).toBeUndefined()
    expect(paletteQuery('hi /co')).toBeUndefined()
    expect(paletteQuery('')).toBeUndefined()
    expect(paletteQuery('/a\nb')).toBeUndefined()
  })
})

describe('filterCommands', () => {
  it('lists everything for an empty query, keeping engine order', () => {
    expect(filterCommands(commands, '').map(c => c.name)).toEqual(
      commands.map(c => c.name),
    )
  })

  it('puts name and alias prefix matches before substring matches', () => {
    expect(filterCommands(commands, 'co').map(c => c.name)).toEqual([
      'compact',
      'context',
      'usage',
      'color',
    ])
    expect(filterCommands(commands, 'pli').map(c => c.name)).toEqual(['simplify'])
    expect(filterCommands(commands, 'zzz')).toEqual([])
  })

  it('hides terminal-only commands', () => {
    expect(filterCommands(commands, 'co', ['color']).map(c => c.name)).toEqual([
      'compact',
      'context',
      'usage',
    ])
  })
})

describe('moveSelection', () => {
  it('wraps around both ends', () => {
    expect(moveSelection(0, 1, 3)).toBe(1)
    expect(moveSelection(2, 1, 3)).toBe(0)
    expect(moveSelection(0, -1, 3)).toBe(2)
    expect(moveSelection(0, 1, 0)).toBe(0)
  })
})
