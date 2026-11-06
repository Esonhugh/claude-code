import { expect, test } from 'bun:test'
import type { Attachment } from './attachments.js'
import { normalizeAttachmentForAPI } from './messages.js'

test('an @-mentioned PDF sends its document, not only the read summary', () => {
  const messages = normalizeAttachmentForAPI({
    type: 'file',
    filename: '/w/doc.pdf',
    displayPath: 'doc.pdf',
    content: {
      type: 'pdf',
      file: { filePath: '/w/doc.pdf', base64: 'JVBERi0=', originalSize: 8 },
    },
  } as Attachment)
  const blocks = messages.flatMap(m =>
    Array.isArray(m.message.content) ? m.message.content : [],
  )
  expect(blocks).toContainEqual({
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
  })
})
