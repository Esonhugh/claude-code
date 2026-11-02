import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'

import type { AttachmentMessage } from '../types/message.js'
import type { Attachment } from './attachments.js'
import { isLoggableMessage } from './sessionStorage.js'

function attachmentMessage(attachment: Attachment): AttachmentMessage {
  return { type: 'attachment', uuid: randomUUID(), timestamp: new Date(0).toISOString(), attachment }
}

test('context attachments persist so --continue rebuilds the same prompt prefix (2.1.311)', () => {
  const listing = { type: 'agent_listing_delta', addedTypes: ['general-purpose'], addedLines: ['- general-purpose'], removedTypes: [], isInitial: true, showConcurrencyNote: false } as unknown as Attachment
  const date = { type: 'date', date: '2026-10-30' } as unknown as Attachment
  expect(isLoggableMessage(attachmentMessage(listing))).toBe(true)
  expect(isLoggableMessage(attachmentMessage(date))).toBe(true)
})

test('empty hook_success attachments stay out of the transcript', () => {
  const base = { type: 'hook_success', hookName: 'Stop', toolUseID: 't', hookEvent: 'Stop' } as const
  expect(isLoggableMessage(attachmentMessage({ ...base, content: '', stdout: ' \n', stderr: '' }))).toBe(false)
  expect(isLoggableMessage(attachmentMessage({ ...base, content: '', stdout: 'ran' }))).toBe(true)
})
