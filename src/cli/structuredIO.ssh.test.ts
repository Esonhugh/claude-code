import assert from 'node:assert/strict'
import { it } from 'bun:test'
import { StructuredIO } from './structuredIO.js'

async function* lines(...values: unknown[]): AsyncGenerator<string> {
  for (const value of values) yield JSON.stringify(value)
}

it('yields targeted control cancellation to the print control loop', async () => {
  const io = new StructuredIO(
    lines({ type: 'control_cancel_request', request_id: 'suggest-1' }),
  )

  const next = await io.structuredInput.next()

  assert.equal(next.done, false)
  assert.deepEqual(next.value, {
    type: 'control_cancel_request',
    request_id: 'suggest-1',
  })
})
