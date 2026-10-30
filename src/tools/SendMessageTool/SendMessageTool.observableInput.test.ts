import { expect, test } from 'bun:test'
import { SendMessageTool } from './SendMessageTool.js'

// Official 2.1.311 hook payloads carry recipient_kind for SendMessage.
test('hook-visible input tags how the recipient was addressed', () => {
  const backfill = (input: Record<string, unknown>) => {
    SendMessageTool.backfillObservableInput!(input as never)
    return input
  }
  expect(backfill({ to: 'mate1', message: 'hi' })).toMatchObject({ type: 'message', recipient: 'mate1', recipient_kind: 'name' })
  expect(backfill({ to: 'a1234567890abcdef', message: 'hi' }).recipient_kind).toBe('agent')
  expect(backfill({ to: 'main', message: 'hi' }).recipient_kind).toBe('main')
  expect(backfill({ to: 'uds:/tmp/x.sock', message: 'hi' }).recipient_kind).toBe('session')
  expect(backfill({ to: 'team-lead', message: { type: 'shutdown_response', request_id: 'r1', approve: true } }))
    .toMatchObject({ type: 'shutdown_response', recipient_kind: 'name', approve: true })
})
