import type { ModInput, ModNext } from '../types.js'

export type MockHandler = (
  $: unknown,
  event: ModInput,
  next: Pick<ModNext, 'signal' | 'origin'>,
) => unknown
export type MockOn = (event: string, handler: MockHandler) => unknown
export type MockClockOptions = { now?: number }
export type MockClock = {
  now(): number
  advance(ms: number): Promise<void>
  set(ms: number): Promise<void>
  settle(): Promise<void>
  sleep(ms: number): Promise<void>
}
export type Mock = {
  env(on: MockOn, variables: Readonly<Record<string, string>>): void
  store(on: MockOn, entries?: Readonly<Record<string, unknown>>): void
  clock(on: MockOn, options?: MockClockOptions): MockClock
}

type Wait = { due: number; finish(error?: unknown): void }

export function createMock(): Mock {
  return {
    env(on, variables) {
      const values = new Map(Object.entries(variables))
      on('env.get', (_$, e) => ({ value: values.get(e.name as string) }))
    },
    store(on, entries = {}) {
      const initial = Object.entries(entries)
      const stores = new Map<string, Map<string, unknown>>()
      const store = (next: Pick<ModNext, 'origin'>) => {
        const name = next.origin.plugin
        let values = stores.get(name)
        if (!values) {
          values = new Map(initial)
          stores.set(name, values)
        }
        return values
      }
      on('store.get', (_$, e, next) => ({ value: store(next).get(e.key as string) }))
      on('store.set', (_$, e, next) => {
        store(next).set(e.key as string, e.value)
        return { value: undefined }
      })
      on('store.delete', (_$, e, next) => {
        store(next).delete(e.key as string)
        return { value: undefined }
      })
      on('store.keys', (_$, _e, next) => ({ value: [...store(next).keys()] }))
    },
    clock(on, options = {}) {
      let now = options.now ?? 0
      if (!Number.isFinite(now)) throw new Error('Invalid clock time')
      const waits = new Set<Wait>()
      let revision = 0
      let movement = Promise.resolve()

      async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
        if (!Number.isFinite(ms) || ms < 0 || !Number.isFinite(now + ms))
          throw new Error('Invalid clock duration')
        signal?.throwIfAborted()
        await new Promise<void>((resolve, reject) => {
          const abort = () => wait.finish(signal?.reason)
          const wait: Wait = {
            due: now + ms,
            finish(error) {
              if (!waits.delete(wait)) return
              revision++
              signal?.removeEventListener('abort', abort)
              if (error !== undefined) reject(error)
              else resolve()
            },
          }
          waits.add(wait)
          revision++
          signal?.addEventListener('abort', abort, { once: true })
        })
      }

      async function drain() {
        // A turn drains arbitrary promise chains, rather than guessing a microtask count.
        let previous: number
        do {
          previous = revision
          await new Promise<void>(resolve => setImmediate(resolve))
        } while (previous !== revision)
      }

      function move(value: number, absolute = false): Promise<void> {
        const result = movement.then(async () => {
          const target = absolute ? value : now + value
          if (!Number.isFinite(value) || !Number.isFinite(target) || target < now)
            throw new Error('Invalid clock movement')
          await drain()
          for (;;) {
            let earliest: Wait | undefined
            for (const wait of waits) {
              if (wait.due <= target && (!earliest || wait.due < earliest.due)) earliest = wait
            }
            if (!earliest) break
            now = earliest.due
            earliest.finish()
            await drain()
          }
          now = target
          await drain()
        })
        movement = result.catch(() => {})
        return result
      }

      on('clock.now', () => ({ value: now }))
      for (const event of ['clock.sleep', 'clock.after', 'clock.every']) {
        on(event, async (_$, e, next) => {
          if (typeof e.ms !== 'number' || (event === 'clock.every' && e.ms < 1))
            throw new Error('Invalid clock duration')
          await sleep(e.ms, next.signal)
          return { value: undefined }
        })
      }
      return {
        now: () => now,
        advance: ms => move(ms),
        set: ms => move(ms, true),
        settle: () => move(0),
        sleep: ms => sleep(ms),
      }
    },
  }
}

export const mock: Mock = createMock()
