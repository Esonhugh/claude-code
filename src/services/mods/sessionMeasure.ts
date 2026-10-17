import { isDeepStrictEqual } from 'node:util'
import { currentLimits } from '../claudeAiLimits.js'
import { validateModSessionUsage, type ModSessionUsage, type ModUsageReader } from './sessionUsage.js'

type UsageUnit = 'context' | 'rateLimits' | 'cost'
type Measurement = ModSessionUsage & { changed: UsageUnit[] }

/** One pending sample per session; observations never overlap or outlive end. */
export function createModSessionMeasure(options: {
  ready(): Promise<unknown>
  captureUsage(): ModUsageReader | undefined
  dispatch(input: Measurement, reader: ModUsageReader, signal: AbortSignal): Promise<unknown>
  onError(error: unknown): void
}) {
  let controller = new AbortController()
  let previous: ModSessionUsage | undefined
  let previousStatus: unknown
  let pending: (() => ModUsageReader | undefined) | undefined
  let running: Promise<void> | undefined

  function request(captureUsage = options.captureUsage): Promise<void> {
    if (controller.signal.aborted) return Promise.resolve()
    pending = captureUsage
    if (running) return running
    const signal = controller.signal
    let abort!: () => void
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, {once:true})
    })
    running = Promise.race([aborted, (async () => {
      await options.ready()
      while (pending && !signal.aborted) {
        const capture = pending
        pending = undefined
        const reader = capture()
        if (!reader) continue
        const usage = await reader({}, signal)
        signal.throwIfAborted()
        validateModSessionUsage(usage)
        // Never push a breakdown, including one returned by a host override.
        const { breakdown: _breakdown, ...context } = usage.context
        const value = structuredClone({...usage,context})
        const status = [currentLimits.status,currentLimits.overageStatus,currentLimits.isUsingOverage]
        const changed: UsageUnit[] = []
        if (!previous || value.context.tokens !== previous.context.tokens ||
          value.context.percent !== previous.context.percent) changed.push('context')
        const windows = (reading: ModSessionUsage) => reading.rateLimits.map(window =>
          [window.kind,Math.floor(window.percentUsed)]).sort((a,b) => String(a[0]).localeCompare(String(b[0])))
        if (previous
          ? !isDeepStrictEqual(windows(value),windows(previous)) || !isDeepStrictEqual(status,previousStatus)
          : value.rateLimits.length > 0) changed.push('rateLimits')
        if (value.cost && (!previous?.cost || value.cost.usd > previous.cost.usd)) changed.push('cost')
        if (!changed.length) continue
        previous = value
        previousStatus = status
        await options.dispatch({...value,changed},reader,signal)
      }
    })()]).catch(error => {
      if (!signal.aborted) options.onError(error)
    }).finally(() => {
      signal.removeEventListener('abort', abort)
      running = undefined
      if (pending && !signal.aborted) void request(pending)
    })
    return running
  }

  async function stop(): Promise<void> {
    pending = undefined
    controller.abort(new Error('Mods session measurement ended'))
    await running
  }

  return {
    request,
    stop,
    async reset() {
      await stop()
      controller = new AbortController()
      previous = undefined
      previousStatus = undefined
    },
  }
}
