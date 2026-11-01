import { beforeEach, expect, test } from 'bun:test'
import { registerHookCallbacks, resetStateForTests } from '../../bootstrap/state.js'
import type { HookJSONOutput, UserPromptExpansionHookInput } from '../../entrypoints/agentSdkTypes.js'
import { getDefaultAppState, type AppState } from '../../state/AppStateStore.js'
import type { Command } from '../../types/command.js'
import { processSlashCommand } from './processSlashCommand.js'

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

async function run(output: HookJSONOutput) {
  const inputs: UserPromptExpansionHookInput[] = []
  registerHookCallbacks({
    UserPromptExpansion: [
      {
        matcher: 'expand-me',
        hooks: [
          {
            type: 'callback',
            callback: async input => {
              inputs.push(input as UserPromptExpansionHookInput)
              return output
            },
          },
        ],
      },
    ],
  })
  let appState: AppState = getDefaultAppState()
  const result = await processSlashCommand(
    '/expand-me some args',
    [],
    [],
    [],
    {
      options: {
        commands: [command],
        tools: [],
        isNonInteractiveSession: true,
        mcpResources: {},
      },
      messages: [],
      abortController: new AbortController(),
      getAppState: () => appState,
      setAppState: (updater: (prev: AppState) => AppState) => {
        appState = updater(appState)
      },
    } as never,
    () => {},
  )
  return { inputs, result }
}

beforeEach(() => {
  resetStateForTests()
})

test('UserPromptExpansion receives the command and its additionalContext is attached', async () => {
  const { inputs, result } = await run({
    hookSpecificOutput: { hookEventName: 'UserPromptExpansion', additionalContext: 'expansion note' },
  })
  expect(inputs).toHaveLength(1)
  expect(inputs[0]).toMatchObject({
    hook_event_name: 'UserPromptExpansion',
    expansion_type: 'slash_command',
    command_name: 'expand-me',
    command_args: 'some args',
    command_source: 'builtin',
    prompt: '/expand-me some args',
  })
  expect(result.shouldQuery).toBe(true)
  const json = JSON.stringify(result.messages)
  expect(json).toContain('expanded some args')
  expect(json).toContain('expansion note')
})

test('a blocking UserPromptExpansion hook stops the expansion', async () => {
  const { result } = await run({ decision: 'block', reason: 'not now' })
  expect(result.shouldQuery).toBe(false)
  const json = JSON.stringify(result.messages)
  expect(json).toContain('UserPromptExpansion operation blocked by hook')
  expect(json).toContain('not now')
  expect(json).toContain('Original prompt: /expand-me some args')
  expect(json).not.toContain('expanded some args')
})

test('suppressOriginalPrompt hides the original prompt from the block message', async () => {
  const { result } = await run({
    decision: 'block',
    reason: 'not now',
    hookSpecificOutput: { hookEventName: 'UserPromptExpansion', suppressOriginalPrompt: true },
  })
  expect(result.shouldQuery).toBe(false)
  expect(JSON.stringify(result.messages)).not.toContain('Original prompt')
})

test('continue:false stops the expansion with the stop reason', async () => {
  const { result } = await run({ continue: false, stopReason: 'halted' })
  expect(result.shouldQuery).toBe(false)
  const json = JSON.stringify(result.messages)
  expect(json).toContain('Operation stopped by hook: halted')
  expect(json).not.toContain('expanded some args')
})
