import { expect, test } from 'bun:test'
import type { Command } from '../../types/command.js'
import { generateCommandSuggestions } from './commandSuggestions.js'

function local(name: string, description: string, aliases?: string[]): Command {
  return {
    type: 'local',
    name,
    description,
    aliases,
    supportsNonInteractive: false,
    load: async () => ({ call: async () => ({ type: 'skip' }) }),
  }
}

const commands = [
  local('compact', 'Free up context by summarizing the conversation so far'),
  local('autocompact', 'Set how full the context gets before auto-summarizing'),
  local('help', 'Show help and available commands'),
  local('rename', 'Rename the current conversation', ['name']),
  local('tui', 'Set the terminal UI renderer (default | fullscreen)'),
  local('init', 'Initialize a new CLAUDE.md file with codebase documentation'),
  local('doctor', 'Health-check your setup'),
  local('config', 'Open settings', ['settings']),
]

const names = (query: string) =>
  generateCommandSuggestions(query, commands).map(item => item.displayText)

// Official 2.1.311: names, parts and aliases match fuzzily; descriptions only
// match when one of their words starts with the query.
test('descriptions match by word prefix, not fuzzily', () => {
  expect(names('/compa')).toEqual(['/compact', '/autocompact'])
  expect(names('/ren')).toEqual(['/rename', '/tui'])
})

test('name prefix ranks before description hits', () => {
  expect(names('/doc')).toEqual(['/doctor', '/init'])
})

test('alias prefix matches show the alias', () => {
  expect(names('/sett')).toEqual(['/config (settings)'])
})

test('rows carry the query and workflows are tagged like official', () => {
  const workflow: Command = {
    type: 'prompt',
    name: 'deep-research',
    description: 'Deep research harness',
    kind: 'workflow',
    source: 'projectSettings',
    progressMessage: '',
    contentLength: 0,
    getPromptForCommand: async () => [],
  }
  const [row] = generateCommandSuggestions('/deep', [workflow])
  expect(row).toMatchObject({ tag: 'dynamic workflow', query: 'deep' })
})
