import { expect, test } from 'bun:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createCombinedAbortSignal } from './combinedAbortSignal.js'

const reasons = [new Error('specific cancellation'), 'custom', false, null, 0, '']
for (const reason of reasons) {
  for (const source of ['first', 'second'] as const) {
    for (const preAborted of [false, true]) {
      test(`combined signal preserves ${String(reason)} from ${source}, preAborted=${preAborted}`, () => {
        const first = new AbortController()
        const second = new AbortController()
        const selected = source === 'first' ? first : second
        if (preAborted) selected.abort(reason)
        const combined = createCombinedAbortSignal(first.signal, { signalB: second.signal })
        try {
          if (!preAborted) selected.abort(reason)
          expect(combined.signal.aborted).toBe(true)
          expect(combined.signal.reason).toBe(reason)
          ;(source === 'first' ? second : first).abort(new Error('later reason'))
          expect(combined.signal.reason).toBe(reason)
        } finally { combined.cleanup() }
      })
    }
  }
}
test('two pre-aborted sources select the first source, including its false reason', () => {
  const combined = createCombinedAbortSignal(AbortSignal.abort(false), { signalB: AbortSignal.abort('second') })
  expect(combined.signal.aborted).toBe(true)
  expect(combined.signal.reason).toBe(false)
  combined.cleanup()
})
test('cleanup removes both sources and cancels the timeout', async () => {
  const first = new AbortController()
  const second = new AbortController()
  const combined = createCombinedAbortSignal(first.signal, { signalB: second.signal, timeoutMs: 5 })
  combined.cleanup()
  first.abort('first')
  second.abort('second')
  await delay(15)
  expect(combined.signal.aborted).toBe(false)
})
test('timeout keeps the existing default AbortError reason', async () => {
  const combined = createCombinedAbortSignal(undefined, { timeoutMs: 5 })
  try {
    await delay(15)
    expect(combined.signal.aborted).toBe(true)
    expect(combined.signal.reason).toMatchObject({ name: 'AbortError' })
  } finally { combined.cleanup() }
})
