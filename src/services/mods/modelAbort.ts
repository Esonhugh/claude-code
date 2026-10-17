import { createAbortController } from '../../utils/abortController.js'

/** Combine model call cancellation without discarding the original reason. */
export function combineModModelSignals(parent?: AbortSignal, local?: AbortSignal): {
  signal: AbortSignal
  cleanup(): void
} {
  const controller = createAbortController()
  const sources = [...new Set([parent, local].filter((signal): signal is AbortSignal => signal !== undefined))]
  const aborted = sources.find(signal => signal.aborted)
  if (aborted) {
    controller.abort(aborted.reason)
    return { signal: controller.signal, cleanup() {} }
  }
  const listeners = sources.map(signal => {
    const abort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    return () => signal.removeEventListener('abort', abort)
  })
  return {
    signal: controller.signal,
    cleanup() { for (const remove of listeners) remove() },
  }
}
