import { expect, test } from 'bun:test'
import { combineModModelSignals } from './modelAbort.js'
import { dispatchModEvent } from './dispatch.js'

test('model signals keep the original reason and only the first cancellation wins', () => {
  const parent = new AbortController(), local = new AbortController()
  const reason = new Error('owned cancellation')
  const combined = combineModModelSignals(parent.signal, local.signal)
  try {
    local.abort(reason)
    expect(combined.signal.reason).toBe(reason)
    expect(parent.signal.aborted).toBe(false)
    parent.abort(new Error('later parent cancellation'))
    expect(combined.signal.reason).toBe(reason)
  } finally { combined.cleanup() }
})

test('already cancelled model sources keep their reason without adding a listener', () => {
  const parent = new AbortController(), local = new AbortController()
  const reason = new Error('already stopped')
  local.abort(reason)
  const combined = combineModModelSignals(parent.signal, local.signal)
  expect(combined.signal.aborted).toBe(true)
  expect(combined.signal.reason).toBe(reason)
  combined.cleanup()
})

test('model signal cleanup detaches duplicate sources and prevents later cancellation', () => {
  const parent = new AbortController()
  let attached = 0, detached = 0
  const signal = {
    get aborted() { return parent.signal.aborted },
    get reason() { return parent.signal.reason },
    addEventListener(...args: Parameters<AbortSignal['addEventListener']>) { attached++; parent.signal.addEventListener(...args) },
    removeEventListener(...args: Parameters<AbortSignal['removeEventListener']>) { detached++; parent.signal.removeEventListener(...args) },
  } as AbortSignal
  const combined = combineModModelSignals(signal, signal)
  combined.cleanup()
  parent.abort()
  expect(attached).toBe(1)
  expect(detached).toBe(1)
  expect(combined.signal.aborted).toBe(false)
})

test('a model core that ignores cancellation is bounded by the teardown grace', async () => {
  const entered = Promise.withResolvers<void>(), held = Promise.withResolvers<unknown>()
  const stop = new AbortController(), reason = new Error('owned cancellation')
  const pending = dispatchModEvent({ event: 'model.complete', input: {model:'haiku',prompt:'held'}, hooks: [], signal: stop.signal, core: async () => {
    entered.resolve()
    return held.promise
  } })
  const outcome = pending.then(() => undefined, error => error)
  try {
    await entered.promise
    stop.abort(reason)
    expect(await outcome).toBe(reason)
  } finally { held.resolve({value:undefined}) }
}, 10_000)
