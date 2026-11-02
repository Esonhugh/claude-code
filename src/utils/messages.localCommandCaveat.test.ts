import { expect, test } from 'bun:test'
import { createSyntheticUserCaveatMessage } from './messages.js'

test('local command caveat uses the 2.1.311 wording', () => {
  expect(createSyntheticUserCaveatMessage().message.content).toBe(
    "<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output goes straight to the user. It's recorded here as context for later messages.</local-command-caveat>",
  )
})
