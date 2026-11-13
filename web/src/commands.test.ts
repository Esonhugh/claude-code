import { describe, expect, it } from 'bun:test'
import { agentCommands, filterCommands, recallList, moveSelection, nativeCommand, paletteQuery, recallPrompt, type SlashCommand, typedInFull, withPageCommands } from './commands'

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

describe('recallList', () => {
  it("walks this box's prompts first, then the folder's history, each once", () => {
    const list = recallList(['a', 'b'], ['b', 'cli one', 'a', 'cli two'])
    expect(list).toEqual(['cli two', 'cli one', 'a', 'b'])
    expect(recallPrompt(list, -1, 1)!.text).toBe('b')
    expect(recallPrompt(list, 1, 1)!.text).toBe('cli one')
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
    expect(nativeCommand('/clear')).toEqual({ clear: true })
    expect(nativeCommand('/reset')).toEqual({ clear: true })
    expect(nativeCommand('/new')).toEqual({ clear: true })
    expect(nativeCommand('/compact')).toBeUndefined()
    expect(nativeCommand('stats')).toBeUndefined()
    expect(nativeCommand('/constructor')).toBeUndefined()
    expect(nativeCommand('/reload-plugins')).toEqual({ reload: true })
    expect(nativeCommand('/status')).toEqual({ panel: 'status' })
    expect(nativeCommand('/diff')).toEqual({ panel: 'files' })
    expect(nativeCommand('/tasks')).toEqual({ panel: 'bg' })
    expect(nativeCommand('/bashes')).toEqual({ panel: 'bg' })
    expect(nativeCommand('/workflows')).toEqual({ panel: 'workflow' })
    expect(nativeCommand('/resume')).toEqual({ search: true })
    expect(nativeCommand('/continue')).toEqual({ search: true })
    expect(nativeCommand('/help')).toEqual({ dialog: 'keys' })
    expect(nativeCommand('/export')).toEqual({ export: true })
    expect(nativeCommand('/export notes.md')).toBeUndefined()
  })
})

describe('withPageCommands', () => {
  const describe_ = (key: string) => `[${key}]`
  it('offers /reload-plugins although the session marks it terminal-only, and keeps the other terminal commands hidden', () => {
    const session = [cmd('compact'), cmd('reload-plugins'), cmd('color'), cmd('doctor')]
    const palette = withPageCommands(session, ['doctor', 'color', 'reload-plugins'], describe_)
    expect(palette.hidden).toEqual(['doctor', 'color'])
    expect(filterCommands(palette.commands, 'rel', palette.hidden).map(c => c.name)).toEqual(['reload-plugins'])
    expect(filterCommands(palette.commands, 'co', palette.hidden).map(c => c.name)).toEqual(['compact'])
  })

  it('adds the page panels the session list lacks, once', () => {
    const palette = withPageCommands([cmd('compact'), cmd('usage', ['cost', 'stats'])], [], describe_)
    expect(palette.commands.map(c => c.name)).toEqual([
      'compact',
      'usage',
      'reload-plugins',
      'plugin',
      'hooks',
      'memory',
      'skills',
      'theme',
      'keybindings',
      'status',
      'diff',
      'tasks',
      'workflows',
      'resume',
      'help',
      'export',
    ])
    expect(palette.commands.find(c => c.name === 'plugin')).toEqual({
      name: 'plugin',
      description: '[cmdPlugin]',
      argumentHint: '',
      aliases: ['plugins'],
    })
    expect(filterCommands(palette.commands, 'plugins').map(c => c.name)).toEqual(['plugin', 'reload-plugins'])
    expect(withPageCommands([cmd('hooks')], [], describe_).commands.filter(c => c.name === 'hooks')).toHaveLength(1)
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
