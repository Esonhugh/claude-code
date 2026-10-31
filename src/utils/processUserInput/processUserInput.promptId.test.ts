import { beforeEach, expect, test } from 'bun:test'
import { registerHookCallbacks, resetStateForTests, setPromptId } from '../../bootstrap/state.js'
import { getDefaultAppState, type AppState } from '../../state/AppStateStore.js'
import type { Command } from '../../types/command.js'
import { processUserInput } from './processUserInput.js'

process.env.ANTHROPIC_API_KEY = 'test-key'

const command: Command = {
  type: 'prompt',
  name: 'expand-me',
  description: 'test command',
  progressMessage: 'testing',
  contentLength: 0,
  source: 'builtin',
  async getPromptForCommand(args) {
    return [{ type: 'text', text: `expanded ${args}` }]
  },
}

beforeEach(() => {
  resetStateForTests()
})

test('UserPromptSubmit and UserPromptExpansion share a fresh prompt_id for a slash command', async () => {
  const ids: Record<string, unknown> = {}
  const record = (event: string) => [
    { matcher: '', hooks: [{ type: 'callback' as const, callback: async (input: { prompt_id?: string }) => { ids[event] = input.prompt_id; return {} } }] },
  ]
  registerHookCallbacks({ UserPromptSubmit: record('submit'), UserPromptExpansion: record('expansion') } as never)
  setPromptId('previous-prompt')
  let appState: AppState = getDefaultAppState()
  await processUserInput({
    input: '/expand-me x',
    mode: 'prompt',
    setToolJSX: () => {},
    context: {
      options: { commands: [command], tools: [], isNonInteractiveSession: true, mcpResources: {} },
      messages: [],
      abortController: new AbortController(),
      getAppState: () => appState,
      setAppState: (updater: (prev: AppState) => AppState) => {
        appState = updater(appState)
      },
    } as never,
  })
  expect(typeof ids.submit).toBe('string')
  expect(ids.submit).not.toBe('previous-prompt')
  expect(ids.expansion).toBe(ids.submit)
})
