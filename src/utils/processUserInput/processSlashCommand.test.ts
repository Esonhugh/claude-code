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
  shouldQueryForCommand(args): boolean {
    return args.trim() !== 'clear'
  },
  async getPromptForCommand() {
    return [{ type: 'text', text: 'Goal is clear' }]
  },
}

process.env.ANTHROPIC_API_KEY = 'test-key'

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
    getAppState: () => ({}) as never,
    setAppState: () => {},
  } as never,
  () => {},
)

assert.equal(result.shouldQuery, false)
assert.equal(result.messages.length, 3)
assert.equal(result.messages[2]?.type, 'system')
assert.equal(
  result.messages[2]?.content,
  '<local-command-stdout>Goal is clear</local-command-stdout>',
)

console.log('processSlashCommand.test.ts passed')
