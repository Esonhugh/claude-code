import assert from 'node:assert/strict'

import type { Command } from '../../types/command.js'
import { processSlashCommand } from './processSlashCommand.js'

const promptCommand: Command = {
  type: 'prompt',
  name: 'test-goal-clear',
  description: 'test command',
  progressMessage: 'testing',
  contentLength: 0,
  source: 'builtin',
  hooks: {
    Stop: [
      {
        matcher: '',
        hooks: [{ type: 'command', command: 'true' }],
      },
    ],
  },
  shouldRegisterHooksForCommand(args): boolean {
    return args.trim() !== 'clear'
  },
  shouldQueryForCommand(args): boolean {
    return args.trim() !== 'clear'
  },
  async getPromptForCommand() {
    return [{ type: 'text', text: 'Goal is clear' }]
  },
}

process.env.ANTHROPIC_API_KEY = 'test-key'

let appState = {
  sessionState: {
    sessionHooks: {},
  },
}

const result = await processSlashCommand(
  '/test-goal-clear clear',
  [],
  [],
  [],
  {
    options: {
      commands: [promptCommand],
      tools: [],
      isNonInteractiveSession: false,
      mcpResources: {},
    },
    messages: [],
    getAppState: () => appState as never,
    setAppState: updater => {
      appState = updater(appState as never) as never
    },
  } as never,
  () => {},
)

assert.equal(result.shouldQuery, false)
assert.equal(result.messages.length, 3)
assert.equal(
  result.messages.some(
    message =>
      message.type === 'attachment' &&
      message.attachment.type === 'command_permissions',
  ),
  false,
)
assert.deepEqual(appState.sessionState.sessionHooks, {})
assert.equal(result.messages[2]?.type, 'system')
assert.equal(
  result.messages[2]?.content,
  '<local-command-stdout>Goal is clear</local-command-stdout>',
)

console.log('processSlashCommand.test.ts passed')
