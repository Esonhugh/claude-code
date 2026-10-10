import { expect, test } from 'bun:test'
import { runWithDeadline } from './deadline.js'
import { ManualDeadlineClock } from './fixtures/manualDeadlineClock.js'

test('arms the deadline before invoking the author body and cancels after success', async () => {
  const clock = new ManualDeadlineClock()
  let called = false
  const result = runWithDeadline(() => { called = true; expect(clock.pending).toBe(1); return 7 }, 200, clock)
  expect(called).toBe(false)
  expect(clock.pending).toBe(1)
  expect(await result).toBe(7)
  expect(clock.pending).toBe(0)
})

test.each([199, 200, 201])('checks elapsed time on fulfillment after %d ms even before timers dispatch', async elapsed => {
  const clock = new ManualDeadlineClock()
  const result = runWithDeadline(() => { clock.advance(elapsed, false); return 'done' }, 200, clock)
  if (elapsed > 200) await expect(result).rejects.toThrow('timed out after 200 ms')
  else expect(await result).toBe('done')
  expect(clock.pending).toBe(0)
})

test('keeps the original body error when rejection arrives after the deadline', async () => {
  const clock = new ManualDeadlineClock()
  const error = new Error('author error')
  await expect(runWithDeadline(() => { clock.advance(201, false); throw error }, 200, clock)).rejects.toBe(error)
  expect(clock.pending).toBe(0)
})

test('expires a pending asynchronous body and cleans up when the body later settles', async () => {
  const clock = new ManualDeadlineClock()
  let finish!: (value: string) => void
  const result = runWithDeadline(() => new Promise<string>(resolve => { finish = resolve }), 200, clock)
  await Promise.resolve()
  clock.advance(200)
  await expect(result).rejects.toThrow('timed out after 200 ms')
  finish('late')
  await Promise.resolve()
  expect(clock.pending).toBe(0)
})

test('clamps the scheduled timer without shortening the declared deadline', async () => {
  const clock = new ManualDeadlineClock()
  let delay = 0
  expect(await runWithDeadline(() => 3, 3_000_000_000, {
    now: () => clock.now(),
    schedule(ms, expire) { delay = ms; return clock.schedule(ms, expire) },
  })).toBe(3)
  expect(delay).toBe(2_147_483_647)
  expect(clock.pending).toBe(0)
})
