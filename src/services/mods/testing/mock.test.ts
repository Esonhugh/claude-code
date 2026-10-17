import { describe, expect, test } from 'bun:test'
import { createMock, mock, type MockHandler, type MockOn } from './mock.js'

function harness() {
  const hooks = new Map<string, MockHandler>()
  const on: MockOn = (event, handler) => { hooks.set(event, handler) }
  const controller = new AbortController()
  return {
    on,
    controller,
    hooks,
    call(event: string, input: Record<string, unknown> = {}, plugin = 'one', signal = controller.signal) {
      const handler = hooks.get(event)
      if (!handler) throw new Error(`Missing hook: ${event}`)
      return Promise.resolve(handler({}, input, { signal, origin: { plugin, tier: 'user' } }))
    },
  }
}

describe('Mods testing mock', () => {
  test('env answers value envelopes, including unset and prototype names', async () => {
    const h = harness()
    mock.env(h.on, { PRESENT: 'yes', EMPTY: '' })
    expect(await h.call('env.get', { name: 'PRESENT' })).toEqual({ value: 'yes' })
    expect(await h.call('env.get', { name: 'EMPTY' })).toEqual({ value: '' })
    expect(await h.call('env.get', { name: 'PATH' })).toEqual({ value: undefined })
    expect(await h.call('env.get', { name: 'toString' })).toEqual({ value: undefined })
    expect([...h.hooks.keys()]).toEqual(['env.get'])
  })

  test('store seeds independent plugin stores and supports every operation', async () => {
    const h = harness()
    createMock().store(h.on, { seed: 1 })
    expect(await h.call('store.keys')).toEqual({ value: ['seed'] })
    expect(await h.call('store.get', { key: 'seed' })).toEqual({ value: 1 })
    expect(await h.call('store.get', { key: 'absent' })).toEqual({ value: undefined })
    expect(await h.call('store.set', { key: '__proto__', value: { ok: true } })).toEqual({ value: undefined })
    expect(await h.call('store.get', { key: '__proto__' })).toEqual({ value: { ok: true } })
    expect(await h.call('store.keys')).toEqual({ value: ['seed', '__proto__'] })
    expect(await h.call('store.keys', {}, 'two')).toEqual({ value: ['seed'] })
    expect(await h.call('store.delete', { key: 'seed' })).toEqual({ value: undefined })
    expect(await h.call('store.delete', { key: 'absent' })).toEqual({ value: undefined })
    expect(await h.call('store.get', { key: 'seed' })).toEqual({ value: undefined })
    const empty = harness()
    mock.store(empty.on)
    expect(await empty.call('store.keys')).toEqual({ value: [] })
  })

  test('clock resolves due order at each due time, including newly scheduled waits', async () => {
    const h = harness()
    const clock = mock.clock(h.on, { now: 100 })
    const seen: number[] = []
    expect(await h.call('clock.now')).toEqual({ value: 100 })
    const late = h.call('clock.after', { ms: 30 }).then(() => { seen.push(clock.now()) })
    const early = h.call('clock.sleep', { ms: 10 }).then(async result => {
      expect(result).toEqual({ value: undefined })
      seen.push(clock.now())
      await h.call('clock.every', { ms: 5 })
      seen.push(clock.now())
    })
    await clock.advance(30)
    await Promise.all([early, late])
    expect(seen).toEqual([110, 115, 130])
    expect(clock.now()).toBe(130)
    await clock.set(150)
    expect(clock.now()).toBe(150)
  })

  test('settle drains deep microtasks and due-now waits without moving time', async () => {
    const h = harness()
    const clock = mock.clock(h.on)
    let done = false
    const work = (async () => {
      for (let i = 0; i < 100; i++) await Promise.resolve()
      await clock.sleep(0)
      await h.call('clock.sleep', { ms: 0 })
      done = true
    })()
    await clock.settle()
    expect(done).toBe(true)
    expect(clock.now()).toBe(0)
    await work
    let woke = false
    const wait = clock.sleep(5).then(() => { woke = true })
    await clock.advance(4)
    expect(woke).toBe(false)
    await clock.advance(1)
    await wait
    expect(woke).toBe(true)
  })

  test('abort removes pending waits and listeners, including already aborted signals', async () => {
    const h = harness()
    const clock = mock.clock(h.on)
    const reason = new Error('cancelled')
    let removals = 0
    const original = h.controller.signal.removeEventListener.bind(h.controller.signal)
    h.controller.signal.removeEventListener = (...args) => { removals++; original(...args) }
    const wait = h.call('clock.sleep', { ms: 5 }).catch(error => error)
    h.controller.abort(reason)
    expect(await wait).toBe(reason)
    expect(removals).toBe(1)
    await expect(h.call('clock.after', { ms: 10 })).rejects.toBe(reason)
    const times: number[] = []
    const recording = (async () => {
      for (let i = 0; i < 5; i++) {
        await new Promise<void>(resolve => setImmediate(resolve))
        times.push(clock.now())
      }
    })()
    await clock.advance(20)
    await recording
    expect(times).not.toContain(5)
    expect(times).not.toContain(10)
    expect(removals).toBe(1)
  })

  test('equal deadlines keep registration order and normal completion detaches abort', async () => {
    const h = harness()
    const clock = mock.clock(h.on)
    const seen: number[] = []
    const waits = [1, 2, 3].map(n => h.call('clock.sleep', { ms: 1 }).then(() => { seen.push(n) }))
    await clock.advance(1)
    h.controller.abort()
    await Promise.all(waits)
    expect(seen).toEqual([1, 2, 3])
  })

  test('rejects invalid movement and durations without corrupting clock', async () => {
    const h = harness()
    expect(() => mock.clock(h.on, { now: NaN })).toThrow()
    const clock = mock.clock(h.on, { now: 10 })
    await expect(clock.advance(-1)).rejects.toThrow()
    await expect(clock.set(9)).rejects.toThrow()
    await expect(clock.sleep(Infinity)).rejects.toThrow()
    await expect(h.call('clock.every', { ms: 0 })).rejects.toThrow()
    await clock.advance(1)
    expect(clock.now()).toBe(11)
  })
})
