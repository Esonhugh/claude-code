import { expect, test } from 'bun:test'
import type { Command } from './commands.js'
import { toSdkSlashCommands } from './commands.js'

const local = (name: string, extra: Partial<Command> = {}): Command =>
  ({
    type: 'local',
    name,
    description: `${name} description`,
    supportsNonInteractive: true,
    load: async () => ({ call: async () => ({ type: 'skip' }) }),
    ...extra,
  }) as Command

test('SDK command rows match 2.1.311: deduped, invocable only, aliases and builtin flag', () => {
  const rows = toSdkSlashCommands([
    local('rename', { aliases: ['name', 'rename'], argumentHint: '[name]' }),
    local('rename', { description: 'second copy' }),
    local('internal', { userInvocable: false }),
    local('plugin-cmd', { loadedFrom: 'plugin' }),
    {
      type: 'prompt',
      name: 'doctor',
      description: 'long description',
      menuDescription: 'short',
      source: 'bundled',
      progressMessage: '',
      contentLength: 0,
      getPromptForCommand: async () => [],
    } as Command,
  ])

  expect(rows).toEqual([
    {
      name: 'rename',
      description: 'rename description',
      argumentHint: '[name]',
      aliases: ['name'],
      builtin: true,
    },
    { name: 'plugin-cmd', description: 'plugin-cmd description', argumentHint: '' },
    { name: 'doctor', description: 'long description', argumentHint: '', builtin: true },
  ])
})
