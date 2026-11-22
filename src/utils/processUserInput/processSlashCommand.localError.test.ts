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

test('a local command is told which message ran it: the uuid its sender gave, else the message\'s own', async () => {
  const seen: Array<string | undefined> = []
  const reads: Command = {
    type: 'local',
    name: 'reads',
    description: 'test command',
    supportsNonInteractive: true,
    load: async () => ({
      call: async (_args: string, context: { commandMessageUuid?: string }) => {
        seen.push(context.commandMessageUuid)
        return { type: 'text', value: '' }
      },
    }),
  } as never
  let appState: AppState = getDefaultAppState()
  const context = {
    options: { commands: [reads], tools: [], isNonInteractiveSession: true, mcpResources: {} },
    messages: [],
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: (updater: (prev: AppState) => AppState) => {
      appState = updater(appState)
    },
  } as never
  await processSlashCommand('/reads', [], [], [], context, () => {}, 'host-uuid-1')
  const own = await processSlashCommand('/reads', [], [], [], context, () => {})
  expect(seen[0]).toBe('host-uuid-1')
  expect(own.messages.map(message => message.uuid)).toContain(seen[1])
})
