import { createAbortController } from './abortController.js'

/**
 * Creates a combined AbortSignal that aborts when the input signal aborts,
 * an optional second signal aborts, or an optional timeout elapses.
 * Returns both the signal and a cleanup function that removes event listeners
 * and clears the internal timeout timer.
 *
 * Use `timeoutMs` instead of passing `AbortSignal.timeout(ms)` as a signal —
 * under Bun, `AbortSignal.timeout` timers are finalized lazily and accumulate
 * in native memory until they fire (measured ~2.4KB/call held for the full
 * timeout duration). This implementation uses `setTimeout` + `clearTimeout`
 * so the timer is freed immediately on cleanup.
 */
export function createCombinedAbortSignal(
  signal: AbortSignal | undefined,
  opts?: { signalB?: AbortSignal; timeoutMs?: number },
): { signal: AbortSignal; cleanup: () => void } {
  const { signalB, timeoutMs } = opts ?? {}
  const combined = createAbortController()

  if (signal?.aborted || signalB?.aborted) {
    combined.abort(signal?.aborted ? signal.reason : signalB!.reason)
    return { signal: combined.signal, cleanup: () => {} }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const abortCombined = (reason?: unknown) => {
    if (timer !== undefined) clearTimeout(timer)
    combined.abort(reason)
  }
  const abortFirst = () => abortCombined(signal!.reason)
  const abortSecond = () => abortCombined(signalB!.reason)

  if (timeoutMs !== undefined) {
    timer = setTimeout(abortCombined, timeoutMs)
    timer.unref?.()
  }
  signal?.addEventListener('abort', abortFirst, { once: true })
  signalB?.addEventListener('abort', abortSecond, { once: true })

  const cleanup = () => {
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener('abort', abortFirst)
    signalB?.removeEventListener('abort', abortSecond)
  }

  return { signal: combined.signal, cleanup }
}
