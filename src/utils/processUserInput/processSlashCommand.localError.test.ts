import { beforeEach, expect, test } from 'bun:test'
import { resetStateForTests } from '../../bootstrap/state.js'
import { getDefaultAppState, type AppState } from '../../state/AppStateStore.js'
import type { Command } from '../../types/command.js'
import { processSlashCommand } from './processSlashCommand.js'

const failing: Command = {
  type: 'local',
  name: 'fails',
  description: 'test command',
  supportsNonInteractive: true,
  load: async () => ({
    call: async () => {
      throw new Error('Not enough messages to compact.')
    },
  }),
} as never

beforeEach(() => {
  resetStateForTests()
})

test('a local command that throws reports its message as the -p result like 2.1.311', async () => {
  let appState: AppState = getDefaultAppState()
  const result = await processSlashCommand('/fails', [], [], [], {
    options: { commands: [failing], tools: [], isNonInteractiveSession: true, mcpResources: {} },
    messages: [],
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: (updater: (prev: AppState) => AppState) => {
      appState = updater(appState)
    },
  } as never, () => {})
  expect(result.shouldQuery).toBe(false)
  expect(result.resultText).toBe('Not enough messages to compact.')
})
