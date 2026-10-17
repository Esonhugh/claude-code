import type { DeadlineClock } from '../deadline.js'

export class ManualDeadlineClock implements DeadlineClock {
  private time = 0
  private sequence = 0
  private timers = new Map<number, { at: number; expire: () => void }>()

  now() { return this.time }
  get pending() { return this.timers.size }
  schedule(delayMs: number, expire: () => void) {
    const id = ++this.sequence
    this.timers.set(id, { at: this.time + delayMs, expire })
    return () => { this.timers.delete(id) }
  }
  advance(ms: number, dispatch = true) {
    this.time += ms
    if (!dispatch) return
    for (const [id, timer] of this.timers) {
      if (timer.at > this.time) continue
      this.timers.delete(id)
      timer.expire()
    }
  }
}
