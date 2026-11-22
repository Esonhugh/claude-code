import { expect, test } from 'bun:test'
import { StdoutMessageSchema } from './controlSchemas.js'

test('the note after a refused response keeps refused_message_id through validation', () => {
  const parsed = StdoutMessageSchema().parse({
    type: 'user',
    message: { role: 'user', content: 'stopped by a safety classifier' },
    parent_tool_use_id: null,
    isSynthetic: true,
    refused_message_id: 'msg_refused',
    uuid: '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b',
    session_id: 'session',
  })
  expect(parsed).toMatchObject({ type: 'user', refused_message_id: 'msg_refused' })
})
