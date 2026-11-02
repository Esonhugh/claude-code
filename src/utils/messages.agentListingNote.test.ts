import { expect, test } from 'bun:test'
import { normalizeAttachmentForAPI } from './messages.js'

test('the initial agent listing scopes the concurrency note to independent work', () => {
  const [message] = normalizeAttachmentForAPI({
    type: 'agent_listing_delta',
    addedTypes: ['Explore'],
    addedLines: ['- Explore: Read-only search agent'],
    removedTypes: [],
    isInitial: true,
    showConcurrencyNote: true,
  } as unknown as Parameters<typeof normalizeAttachmentForAPI>[0])
  const content = message!.message.content
  const text = typeof content === 'string' ? content : content.map(b => ('text' in b ? b.text : '')).join('\n')

  expect(text).toContain('When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently.')
  expect(text).not.toContain('whenever possible')
})
