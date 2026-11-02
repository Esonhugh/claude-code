import { expect, mock, test } from 'bun:test'

let suppressed = 0
const real = await import('./attachments.js')
mock.module('./attachments.js', () => ({
  ...real,
  suppressNextSkillListing: () => {
    suppressed++
  },
}))
const { restoreSkillStateFromMessages } = await import('./conversationRecovery.js')
const { createUserMessage } = await import('./messages.js')

test('a resumed post-compact chain does not re-announce the skill listing (like 2.1.311)', () => {
  restoreSkillStateFromMessages([createUserMessage({ content: 'hello' })])
  expect(suppressed).toBe(0)
  restoreSkillStateFromMessages([
    createUserMessage({ content: 'This session is being continued…', isCompactSummary: true }),
    createUserMessage({ content: 'next' }),
  ])
  expect(suppressed).toBe(1)
})
