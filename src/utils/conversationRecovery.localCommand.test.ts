import { expect, test } from 'bun:test'

import { deserializeMessagesWithInterruptDetection } from './conversationRecovery.js'
import { createAssistantMessage, createUserMessage, NO_RESPONSE_REQUESTED } from './messages.js'

test('a session ending on local command output is not an interrupted prompt (like 2.1.311)', () => {
  // `-p --continue "/compact"` leaves the command and its stdout as the last
  // user messages; the next --continue must not add a "No response requested."
  // reply before the new prompt.
  const result = deserializeMessagesWithInterruptDetection([
    createUserMessage({ content: 'hello' }),
    createAssistantMessage({ content: 'hi' }),
    createUserMessage({
      content: '<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>',
    }),
    createUserMessage({ content: '<local-command-stdout>Compacted </local-command-stdout>' }),
  ])
  expect(result.turnInterruptionState).toEqual({ kind: 'none' })
  const last = result.messages.at(-1)!
  expect(last.type).toBe('user')
  expect(
    result.messages.some(
      m => m.type === 'assistant' && JSON.stringify(m.message.content).includes(NO_RESPONSE_REQUESTED),
    ),
  ).toBe(false)
})
