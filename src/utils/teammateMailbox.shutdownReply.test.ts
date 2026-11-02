import { expect, test } from 'bun:test'
import { withShutdownReplyInstructions } from './teammateMailbox.js'

const request = (requestId: string) =>
  JSON.stringify({ type: 'shutdown_request', requestId, from: 'team-lead', reason: 'done', timestamp: '2026-10-29T00:00:00.000Z' })

test("a lead's shutdown_request carries official 2.1.311 reply instructions", () => {
  const text = request('shutdown-1793292872731@mate1')
  expect(withShutdownReplyInstructions(text, 'team-lead')).toBe(
    `${text}\n\nThis is a shutdown request. To approve it, call SendMessage with exactly this input, where "message" is a JSON object rather than a string: {"to":"team-lead","message":{"type":"shutdown_response","request_id":"shutdown-1793292872731@mate1","approve":true}}. Approving ends your process; a plain-text acknowledgment does not shut you down. To decline, for example because you're mid-task, send the same input with "approve": false and a "reason".`,
  )
})

test('an unusual request id gets a placeholder and the copy-verbatim hint', () => {
  const out = withShutdownReplyInstructions(request('custom id'), 'team-lead')
  expect(out).toContain('"request_id":"<requestId of the shutdown request>"')
  expect(out).toContain("and request_id is the request's requestId value, copied verbatim")
})

test('other senders and other messages are left alone', () => {
  const text = request('shutdown-1@mate1')
  expect(withShutdownReplyInstructions(text, 'mate2')).toBe(text)
  expect(withShutdownReplyInstructions('hello', 'team-lead')).toBe('hello')
})

test('the request with reply instructions still summarizes as a shutdown request', async () => {
  const { getShutdownMessageSummary } = await import('../components/messages/ShutdownMessage.js')
  const text = withShutdownReplyInstructions(request('shutdown-1@mate1'), 'team-lead')
  expect(getShutdownMessageSummary(text)).toBe('[Shutdown Request from team-lead] done')
  expect(getShutdownMessageSummary(`${request('shutdown-1@mate1')}\n\nsomething else`)).toBeNull()
})
