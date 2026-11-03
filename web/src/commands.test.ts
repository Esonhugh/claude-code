import { describe, expect, it } from 'bun:test'
import { agentCommands, filterCommands, moveSelection, nativeCommand, paletteQuery, recallPrompt, type SlashCommand, typedInFull } from './commands'

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

describe('agentCommands', () => {
  it('keeps only skills: an agent gets the text as typed, so local commands do nothing there', () => {
    expect(agentCommands(commands, ['simplify', 'missing']).map(c => c.name)).toEqual(['simplify'])
    expect(agentCommands(commands, [])).toEqual([])
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

describe('recallPrompt', () => {
  const prompts = ['first', 'second', 'third']
  it('walks back from the newest prompt and stops at the oldest', () => {
    expect(recallPrompt(prompts, -1, 1)).toEqual({ index: 0, text: 'third' })
    expect(recallPrompt(prompts, 1, 1)).toEqual({ index: 2, text: 'first' })
    expect(recallPrompt(prompts, 2, 1)).toBeUndefined()
  })
  it('comes forward to the empty input', () => {
    expect(recallPrompt(prompts, 1, -1)).toEqual({ index: 0, text: 'third' })
    expect(recallPrompt(prompts, 0, -1)).toEqual({ index: -1, text: '' })
    expect(recallPrompt(prompts, -1, -1)).toBeUndefined()
  })
  it('has nothing to recall in a new chat', () => {
    expect(recallPrompt([], -1, 1)).toBeUndefined()
  })
})

describe('nativeCommand', () => {
  it('maps bare commands with a page panel and leaves the rest to the session', () => {
    expect(nativeCommand('/stats')).toEqual({ dialog: 'stats' })
    expect(nativeCommand(' /usage ')).toEqual({ dialog: 'settings', tab: 'usage' })
    expect(nativeCommand('/cost')).toEqual({ dialog: 'settings', tab: 'usage' })
    expect(nativeCommand('/plugin')).toEqual({ dialog: 'plugins' })
    expect(nativeCommand('/keybindings')).toEqual({ dialog: 'keys' })
    expect(nativeCommand('/model')).toEqual({ menu: 'model' })
    expect(nativeCommand('/effort')).toEqual({ menu: 'model' })
    expect(nativeCommand('/model sonnet')).toBeUndefined()
    expect(nativeCommand('/stats now')).toBeUndefined()
    expect(nativeCommand('/compact')).toBeUndefined()
    expect(nativeCommand('stats')).toBeUndefined()
    expect(nativeCommand('/constructor')).toBeUndefined()
  })
})

describe('typedInFull', () => {
  it('is true for the name, an alias, or a page command, so Enter sends instead of completing', () => {
    const usage = cmd('usage', ['cost', 'stats'])
    expect(typedInFull('/usage', usage)).toBe(true)
    expect(typedInFull('/stats', usage)).toBe(true)
    expect(typedInFull('/cost', usage)).toBe(true)
    expect(typedInFull('/theme', cmd('themes'))).toBe(true)
    expect(typedInFull('/us', usage)).toBe(false)
    expect(typedInFull('/sta', usage)).toBe(false)
  })
})
