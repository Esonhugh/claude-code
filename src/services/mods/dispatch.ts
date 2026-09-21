import { isDeepStrictEqual } from 'node:util'
import { matchesModEventPattern, matchesModMatcher } from './matcher.js'
import { createAbortController } from '../../utils/abortController.js'
import type {
  ModDispatchHook,
  ModInput,
  ModNext,
  ModOrigin,
  ModTier,
  ModTraceEntry,
} from './types.js'

type TraceNode = { entry?: ModTraceEntry; below: TraceNode[] }

function traceEntries(nodes: readonly TraceNode[]): readonly ModTraceEntry[] {
  return Object.freeze(
    nodes.flatMap((node) => [
      ...(node.entry ? [node.entry] : []),
      ...traceEntries(node.below),
    ]),
  )
}

const tiers: readonly ModTier[] = [
  'prepend',
  'user',
  'append',
  'builtin',
  'core',
]

export async function dispatchModEvent(options: {
  event: string
  input: ModInput
  hooks: readonly ModDispatchHook[]
  core: (input: ModInput) => Promise<unknown>
  signal?: AbortSignal
  origin?: ModOrigin
  skip?: { plugin: string; registrationId?: number }
  budgetMs?: number
  catchGraceMs?: number
  validateResult?: (value: unknown, nextResults: readonly unknown[]) => void
  validateInput?: (input: ModInput, received: ModInput) => void
  restoreInput?: (input: ModInput, received: ModInput) => ModInput
  onFailure?: (plugin: string, error: unknown) => void
}): Promise<unknown> {
  const budgetMs = options.budgetMs ?? 10_000
  const catchGraceMs = options.catchGraceMs ?? 1000
  const origin: ModOrigin = Object.freeze({
    ...(options.origin ?? { plugin: 'engine', tier: 'core' }),
  })
  const skip =
    options.skip ??
    (options.event !== 'engine.create' && options.origin
      ? { plugin: options.origin.plugin }
      : undefined)

  const hooks = [...options.hooks].sort(
    (a, b) => tiers.indexOf(a.tier) - tiers.indexOf(b.tier),
  )
  const pinned = (
    options.event === 'tool.call'
      ? ['tool', 'tool_use_id', 'agentId']
      : options.event === 'plugin.register'
        ? ['name', 'tier', 'root', 'provenance', 'version', 'uses']
        : options.event === 'command.run'
          ? ['command', 'origin', 'presentation']
          : []
  ).map(
    (key) => [
      key,
      ['uses', 'origin', 'presentation'].includes(key) ? structuredClone(options.input[key]) : options.input[key],
    ] as const,
  )

  async function run(
    index: number,
    input: ModInput,
    parent?: AbortSignal,
    skipped: ReadonlySet<ModTier> = new Set(),
    trace: TraceNode[] = [],
  ): Promise<unknown> {
    parent?.throwIfAborted()
    while (index < hooks.length) {
      const { registration, tier, plugin } = hooks[index]!
      const skipRegistration =
        skip?.plugin === plugin &&
        (skip.registrationId === undefined ||
          skip.registrationId === registration.id)
      const matches =
        matchesModEventPattern(registration.event, options.event) &&
        matchesModMatcher(registration.matcher ?? {}, input)
      if (matches && !skipRegistration) {
        if (!skipped.has(tier)) break
        trace.push({
          entry: Object.freeze({
            plugin,
            tier,
            outcome: 'skipped',
            received: input,
          }),
          below: [],
        })
      }
      index++
    }
    const hook = hooks[index]
    const node: TraceNode = { below: [] }
    trace.push(node)
    function record(outcome: string, returned?: unknown) {
      node.entry = Object.freeze({
        plugin: hook?.plugin ?? 'engine',
        tier: hook?.tier ?? 'core',
        outcome,
        received: input,
        returned,
      })
    }
    if (!hook) {
      let abort!: () => void
      const abandoned = new Promise<never>((_resolve, reject) => {
        abort = () => reject(parent!.reason)
        parent?.addEventListener('abort', abort, { once: true })
      })
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => {
            parent?.throwIfAborted()
            return options.core(input)
          }),
          abandoned,
        ])
        record('returned', result)
        return result
      } catch (error) {
        record('rejected')
        throw error
      } finally {
        parent?.removeEventListener('abort', abort)
      }
    }

    const lifetime = createAbortController()
    let controller = createAbortController()
    let phase: 'active' | 'recovering' | 'catch' | 'done' = 'active'
    let inFlight: Promise<unknown> | undefined
    const nextResults: unknown[] = []
    const nextErrors = new Set<unknown>()
    let lastResult: unknown
    let lastResolved = false
    let pending = 0
    let remaining = budgetMs
    let started = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let expire: (() => void) | undefined
    let timedOut = false
    let rejectAbandoned!: (error: unknown) => void
    const abandoned = new Promise<never>((_resolve, reject) => {
      rejectAbandoned = reject
    })
    // Cancellation can arrive between awaits; always observe its rejection.
    void abandoned.catch(() => {})
    const abort = () => {
      phase = 'done'
      rejectAbandoned(parent!.reason)
      lifetime.abort(parent!.reason)
      controller.abort(parent!.reason)
    }
    parent?.addEventListener('abort', abort, { once: true })

    function stopTimer() {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
        remaining -= performance.now() - started
      }
    }
    function startTimer() {
      if (
        options.event === 'engine.create' ||
        !expire ||
        timer !== undefined ||
        phase === 'done' ||
        phase === 'recovering'
      )
        return
      if (phase === 'active' && pending > 0) return
      started = performance.now()
      timer = setTimeout(expire, Math.max(0, remaining))
    }
    function below(rewritten: ModInput, target?: ModTier): Promise<unknown> {
      if (
        rewritten === null ||
        typeof rewritten !== 'object' ||
        Array.isArray(rewritten)
      ) {
        return Promise.reject(
          new Error(`Mod ${hook.plugin} next requires an input object`),
        )
      }
      if (
        options.event === 'plugin.register' &&
        !Object.hasOwn(rewritten, 'version') &&
        Object.hasOwn(options.input, 'version')
      ) {
        rewritten = { ...rewritten, version: options.input.version }
      }
      if (options.event === 'command.run' && !Object.hasOwn(rewritten, 'presentation')) {
        rewritten = { ...rewritten, presentation: options.input.presentation }
      }
      rewritten = options.restoreInput?.(rewritten, input) ?? rewritten
      for (const [key, value] of pinned) {
        const unchanged =
          ['uses', 'origin', 'presentation'].includes(key)
            ? isDeepStrictEqual(rewritten[key], value)
            : rewritten[key] === value
        if (!unchanged)
          return Promise.reject(
            new Error(
              `Mod ${hook.plugin} cannot rewrite ${key} for ${options.event}`,
            ),
          )
      }
      try { options.validateInput?.(rewritten, input) }
      catch (error) { return Promise.reject(error) }
      const descent = new Set(skipped)
      if (target !== undefined) {
        if (
          !(
            hook.tier === 'prepend' &&
            ['append', 'builtin', 'core'].includes(target)
          ) &&
          !(hook.tier === 'append' && target === 'core')
        ) {
          return Promise.reject(
            new Error(
              `Mod ${hook.plugin} cannot continue from ${hook.tier} to ${target}`,
            ),
          )
        }
        for (
          let tier = tiers.indexOf(hook.tier) + 1;
          tier < tiers.indexOf(target);
          tier++
        )
          descent.add(tiers[tier]!)
      }
      if (pending++ === 0 && phase === 'active') stopTimer()
      node.below = []
      lastResolved = false
      const branch = run(
        index + 1,
        rewritten,
        lifetime.signal,
        descent,
        node.below,
      )
      inFlight = branch
      void branch.then(
        (result) => {
          if (inFlight === branch) {
            lastResolved = true
            lastResult = result
          }
          settled()
        },
        (error) => {
          nextErrors.add(error)
          settled()
        },
      )
      return branch
    }
    function settled() {
      pending--
      if (pending === 0) startTimer()
    }
    const replay = (rewritten: ModInput, target?: ModTier) =>
      inFlight ?? below(rewritten, target)

    async function invoke(
      catching: boolean,
      failure?: unknown,
    ): Promise<unknown> {
      phase = catching ? 'catch' : 'active'
      controller = createAbortController()
      const ownController = controller
      remaining = catching ? catchGraceMs : budgetMs
      const continueBelow = (rewritten: ModInput, target?: ModTier) => {
        if (
          phase !== (catching ? 'catch' : 'active') ||
          ownController.signal.aborted
        ) {
          return Promise.reject(
            ownController.signal.reason ??
              new Error(`Mod ${hook.plugin} next is no longer active`),
          )
        }
        const result = catching
          ? replay(rewritten, target)
          : below(rewritten, target)
        void result.then(
          (value) => { nextResults.push(value) },
          () => {},
        )
        return result
      }
      const next = ((rewritten: ModInput) =>
        continueBelow(rewritten)) as ModNext
      Object.defineProperties(next, {
        to: {
          value: (rewritten: ModInput, target: ModTier) => {
            if (target === undefined && !(catching && inFlight)) {
              return Promise.reject(
                new Error(`Mod ${hook.plugin} next.to requires a tier`),
              )
            }
            return continueBelow(rewritten, target)
          },
        },
        is: { value: (event: string) => event === options.event },
        signal: { value: ownController.signal },
        event: { get: () => options.event },
        origin: { get: () => origin },
        trace: { get: () => traceEntries(node.below) },
        ...(catching
          ? {
              error: { value: failure },
              called: { value: inFlight !== undefined },
            }
          : {}),
      })
      Object.freeze(next)
      const timeout = new Promise<never>((_resolve, reject) => {
        expire = () => {
          const error = new Error(
            `Mod ${hook.plugin} timed out for ${options.event}`,
          )
          timedOut = true
          phase = 'recovering'
          reject(error)
          ownController.abort(error)
        }
      })
      startTimer()
      try {
        return await Promise.race([
          Promise.resolve().then(() => {
            parent?.throwIfAborted()
            return hook.invoke(input, next, catching)
          }),
          timeout,
          abandoned,
        ])
      } finally {
        stopTimer()
        expire = undefined
        phase = parent?.aborted ? 'done' : 'recovering'
        ownController.abort(new Error(`Mod ${hook.plugin} invocation finished`))
      }
    }

    try {
      try {
        const result = await invoke(false)
        if (result === undefined)
          throw new Error(
            `Mod ${hook.plugin} returned undefined for ${options.event}`,
          )
        options.validateResult?.(result, nextResults)
        record(
          lastResolved && result === lastResult ? 'passed' : 'returned',
          result,
        )
        return result
      } catch (error) {
        parent?.throwIfAborted()
        if (options.event !== 'engine.create' || !nextErrors.has(error)) {
          options.onFailure?.(hook.plugin, error)
        }
        if (options.event === 'engine.create') throw error
        let rejected = false
        let belowError: unknown
        if (inFlight) {
          await Promise.race([
            inFlight.then(
              () => {},
              (error) => {
                rejected = true
                belowError = error
              },
            ),
            abandoned,
          ])
        }
        if (hook.registration.hasCatch) {
          const message = timedOut
            ? rejected
              ? belowError instanceof Error
                ? belowError.message
                : String(belowError)
              : undefined
            : error instanceof Error
              ? error.message
              : String(error)
          const failure = Object.freeze({
            kind: timedOut ? 'timeout' : 'throw',
            ...(message === undefined ? {} : { message }),
            budget: catchGraceMs,
          })
          try {
            const result = await invoke(true, failure)
            if (result !== undefined) {
              options.validateResult?.(result, nextResults)
              record('caught', result)
              return result
            }
          } catch (catchError) {
            parent?.throwIfAborted()
            options.onFailure?.(hook.plugin, catchError)
          }
        }
        const outcome = timedOut ? 'expired' : inFlight ? 'kept' : 'skipped'
        const result = await Promise.race([replay(input), abandoned])
        record(outcome, result)
        return result
      }
    } catch (error) {
      record('rejected')
      throw error
    } finally {
      phase = 'done'
      stopTimer()
      parent?.removeEventListener('abort', abort)
      lifetime.abort(new Error(`Mod ${hook.plugin} frame finished`))
      controller.abort(lifetime.signal.reason)
    }
  }
  return run(0, options.input, options.signal)
}
