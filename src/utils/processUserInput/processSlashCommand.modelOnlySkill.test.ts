import { expect, test } from 'bun:test'

import type { Command } from '../../types/command.js'
import { processSlashCommand } from './processSlashCommand.js'

const NOTICE =
  'This skill can only be invoked by Claude, not directly by users. Ask Claude to use the "ui" skill for you.'

const ui = {
  type: 'prompt',
  name: 'ui',
  description: 'ui',
  progressMessage: 'running',
  contentLength: 0,
  source: 'projectSettings',
  userInvocable: false,
  isHidden: true,
  getPromptForCommand: async () => [{ type: 'text', text: 'UI_BODY' }],
} as unknown as Command

// Official 2.1.322 prints the notice in -p and shows it as command output.
test('a model-only skill typed as a slash command reports the notice as command output', async () => {
  const result = await processSlashCommand(
    '/ui',
    [],
    [],
    [],
    {
      options: { commands: [ui], isNonInteractiveSession: true },
      getAppState: () => ({}) as never,
      setAppState: () => {},
    } as never,
    () => {},
  )
  expect(result.shouldQuery).toBe(false)
  expect(result.resultText).toBe(NOTICE)
  const contents = result.messages.map(message =>
    message.type === 'user' ? message.message.content : undefined,
  )
  expect(contents).toContain(`<local-command-stdout>${NOTICE}</local-command-stdout>`)
})
