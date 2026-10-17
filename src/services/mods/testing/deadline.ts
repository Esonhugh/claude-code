export type DeadlineClock = {
  now(): number
  schedule(delayMs: number, expire: () => void): () => void
}

const wallClock: DeadlineClock = {
  now: () => performance.now(),
  schedule(delayMs, expire) {
    const timer = setTimeout(expire, delayMs)
    return () => clearTimeout(timer)
  },
}

export function runWithDeadline<T>(
  body: () => T | PromiseLike<T>,
  timeoutMs: number,
  clock: DeadlineClock = wallClock,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = clock.now()
    const overran = () => new Error(`timed out after ${timeoutMs} ms`)
    const cancel = clock.schedule(Math.min(timeoutMs, 2_147_483_647), () => reject(overran()))
    Promise.resolve().then(body).then(value => {
      cancel()
      // A synchronous body can block the timer; fulfillment must still meet the deadline.
      if (clock.now() - started > timeoutMs) reject(overran())
      else resolve(value)
    }, error => {
      cancel()
      reject(error)
    })
  })
}
