import { isDeepStrictEqual } from 'node:util'
import type { ModDispatchOptions, ModSnapshot } from './runtime.js'
import type { ModInput } from './types.js'

export type SessionReceiveOrigin = { kind: 'bridge' | 'task-notification' | 'scheduled-trigger' | 'peer' | 'peer-send-message' | 'projects-relay' | 'slack-ping' | 'unclassified' }
export type SessionReceiveEvent = {
  source: string
  kind: string
  data: Record<string, unknown>
  untrustedKeys: readonly string[]
}
export type SessionReceiveInput = {
  origin: SessionReceiveOrigin
  text: string
  /** Supplied only by an ingress that has verified the server's wake stamp. */
  event?: SessionReceiveEvent
}
export type SessionReceiveResult = { text: string; consumed?: undefined } | { consumed: string; text?: undefined }

export function validateSessionReceiveResult(result: unknown): asserts result is SessionReceiveResult {
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw new Error('session.receive must return text or consumed')
  const value = result as SessionReceiveResult
  if (!(typeof value.text === 'string' && value.consumed === undefined) &&
      !(typeof value.consumed === 'string' && value.text === undefined))
    throw new Error('session.receive must return text or consumed')
}

export async function runModSessionReceive(
  snapshot: ModSnapshot | undefined,
  input: SessionReceiveInput,
  enqueue: (input: SessionReceiveInput) => void | SessionReceiveResult | Promise<void | SessionReceiveResult>,
  signal: AbortSignal,
): Promise<SessionReceiveResult> {
  const initial = structuredClone(input)
  let admission: Promise<SessionReceiveResult> | undefined
  const options: ModDispatchOptions = {
    signal,
    validateResult: validateSessionReceiveResult,
    validateInput(value) {
      if (typeof value.text !== 'string') throw new Error('session.receive requires text')
      for (const key of ['origin', 'event'] as const) {
        if (!isDeepStrictEqual(value[key], initial[key]))
          throw new Error(`session.receive cannot rewrite ${key}`)
      }
    },
  }
  signal.throwIfAborted()
  let abort!: () => void
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  const core = (value: ModInput, branch?: AbortSignal) => {
    // Multiple continuations still refer to the same inbound delivery.
    admission ??= (async (): Promise<SessionReceiveResult> => {
      signal.throwIfAborted()
      branch?.throwIfAborted()
      options.validateInput!(value, initial)
      const entered = structuredClone(value) as SessionReceiveInput
      const result: void | SessionReceiveResult = await enqueue(entered)
      if (result === undefined) return { text: entered.text }
      validateSessionReceiveResult(result)
      return result as SessionReceiveResult
    })()
    return admission
  }
  try {
    const delivery = snapshot
      ? snapshot.dispatch('session.receive', initial, core, options) as Promise<SessionReceiveResult>
      : core(initial)
    return await Promise.race([delivery, aborted])
  } finally {
    try {
      if (admission) await Promise.race([Promise.allSettled([admission]), aborted])
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }
}
