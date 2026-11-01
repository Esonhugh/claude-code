import { expect, test } from 'bun:test'
import { TEAMMATE_SHUTDOWN_APPROVED } from './constants.js'
import { linkTurnToLifecycle } from './inProcessRunner.js'

test('stopping a teammate aborts its running turn too', () => {
  const lifecycle = new AbortController()
  const turn = new AbortController()
  linkTurnToLifecycle(lifecycle, turn)
  lifecycle.abort('stopped')
  expect(turn.signal.aborted).toBe(true)
  expect(turn.signal.reason).toBe('stopped')
})

// Like official 2.1.311, the teammate's own shutdown_response finishes its tool call
// (PostToolUse fires) and the runner exits after the result instead of cancelling it.
test('a teammate approving its own shutdown leaves the running turn to finish', () => {
  const lifecycle = new AbortController()
  const turn = new AbortController()
  linkTurnToLifecycle(lifecycle, turn)
  lifecycle.abort(TEAMMATE_SHUTDOWN_APPROVED)
  expect(turn.signal.aborted).toBe(false)
})
