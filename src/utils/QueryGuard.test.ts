import { describe, expect, test } from 'bun:test'
import { QueryGuard } from './QueryGuard.js'

describe('QueryGuard draining after forceEnd', () => {
  test('a force-ended running query drains until its stale end()', () => {
    const guard = new QueryGuard()
    let notified = 0
    guard.subscribe(() => notified++)
    const generation = guard.tryStart()!

    guard.forceEnd()
    expect(guard.isActive).toBe(false)
    expect(guard.getDrainingSnapshot()).toBe(true)

    notified = 0
    expect(guard.end(generation)).toBe(false)
    expect(guard.getDrainingSnapshot()).toBe(false)
    expect(notified).toBe(1)
  })

  test('cancelling a dispatch reservation does not drain', () => {
    const guard = new QueryGuard()
    guard.reserve()
    guard.forceEnd()
    expect(guard.isDraining).toBe(false)
  })

  test('a newer query does not clear the older drain', () => {
    const guard = new QueryGuard()
    const first = guard.tryStart()!
    guard.forceEnd()
    const second = guard.tryStart()!
    expect(guard.end(second)).toBe(true)
    expect(guard.isDraining).toBe(true)
    guard.end(first)
    expect(guard.isDraining).toBe(false)
  })
})
