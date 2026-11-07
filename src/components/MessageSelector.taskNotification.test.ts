import { expect, test } from 'bun:test'
import { createUserMessage } from '../utils/messages.js'
import { selectableUserMessagesFilter } from './MessageSelector.js'

test('the rewind list skips plain-text task notifications such as "agent was stopped"', () => {
  const notice = createUserMessage({ content: 'Background agent "worker 1" was stopped by the user.' })
  // @ts-ignore - origin is stamped after creation, as in handlePromptSubmit
  notice.origin = { kind: 'task-notification' }
  expect(selectableUserMessagesFilter(notice)).toBe(false)
  const human = createUserMessage({ content: 'hello' })
  // @ts-ignore
  human.origin = { kind: 'human' }
  expect(selectableUserMessagesFilter(human)).toBe(true)
})
