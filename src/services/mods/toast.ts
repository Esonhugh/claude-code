import type { ModInput } from './types.js'

export function createModToasts({
  show,
  dropped,
  now = () => performance.now(),
}: {
  show(plugin: string, text: string, timeoutMs: number): void
  dropped?(plugin: string): void
  now?: () => number
}): (plugin: string, input: ModInput) => void {
  const lastShown = new Map<string, number>()
  return (plugin, input) => {
    if (typeof input.text !== 'string' || !input.text.trim())
      throw new TypeError('ui.toast requires non-empty text')
    if (input.text.length > 4096)
      throw new TypeError('ui.toast text must be at most 4096 UTF-16 code units')
    const timeoutMs = input.timeoutMs === undefined ? 4000 : input.timeoutMs
    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
      throw new TypeError('ui.toast timeoutMs must be an integer from 1 to 60000')
    const time = now()
    const previous = lastShown.get(plugin)
    if (previous !== undefined && time - previous < 2000) {
      dropped?.(plugin)
      return
    }
    show(plugin, input.text, timeoutMs)
    lastShown.set(plugin, time)
  }
}
