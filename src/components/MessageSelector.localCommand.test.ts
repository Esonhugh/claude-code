import { expect, test } from 'bun:test'
import { createUserMessage, formatCommandInputTags, markLocalCommandInput } from '../utils/messages.js'
import { selectableUserMessagesFilter } from './MessageSelector.js'

test('the rewind list skips local command input rows, like official', () => {
  const input = createUserMessage({ content: formatCommandInputTags('context', '') })
  expect(selectableUserMessagesFilter(input)).toBe(true)
  expect(selectableUserMessagesFilter(markLocalCommandInput(input))).toBe(false)
  expect(selectableUserMessagesFilter({ ...input })).toBe(false)
  expect(selectableUserMessagesFilter(createUserMessage({ content: 'hello' }))).toBe(true)
})
