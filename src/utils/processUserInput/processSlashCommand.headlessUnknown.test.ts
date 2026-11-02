import { beforeEach, expect, test } from 'bun:test'
import { resetStateForTests } from '../../bootstrap/state.js'
import { getDefaultAppState, type AppState } from '../../state/AppStateStore.js'
import type { Command } from '../../types/command.js'
import { processSlashCommand } from './processSlashCommand.js'

const skill: Command = {
  type: 'prompt',
  name: 'review-pr',
  description: 'a skill',
  progressMessage: 'testing',
  contentLength: 0,
  source: 'projectSettings',
  async getPromptForCommand() {
    return [{ type: 'text', text: 'x' }]
  },
} as never

function run(input: string) {
  let appState: AppState = getDefaultAppState()
  return processSlashCommand(input, [], [], [], {
    options: { commands: [skill], tools: [], isNonInteractiveSession: true, mcpResources: {} },
    messages: [],
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: (updater: (prev: AppState) => AppState) => {
      appState = updater(appState)
    },
  } as never, () => {})
}

beforeEach(() => {
  resetStateForTests()
})

test('a built-in command missing from -p says it is not available here like 2.1.311', async () => {
  const result = await run('/permissions')
  expect(result.shouldQuery).toBe(false)
  expect(result.resultText).toBe("/permissions isn't available in this environment.")
})

test('an unknown slash command in -p goes to the model with a note like 2.1.311', async () => {
  const result = await run('/review-pt please')
  expect(result.shouldQuery).toBe(true)
  const text = JSON.stringify(result.messages)
  expect(text).toContain('/review-pt please')
  expect(text).toContain(
    "The user's message starts with the slash command /review-pt, but no command with that name is available in this session, so it did not run. The closest available command is /review-pr. Ask the user before running it. Slash commands available in this session: /review-pr. Treat the message as a plain request",
  )
})
