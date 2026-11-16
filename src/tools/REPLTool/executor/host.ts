import {
  replWorkerMain,
  type ReplHostMessage,
  type ReplRunningRow,
  type ReplWorkerMessage,
  type ReplWorkerToolSpec,
} from './worker.js'

export type ReplRunOptions = {
  /** Script time limit; default 30000, max 600000. Time spent awaiting callTool is not counted. */
  timeoutMs?: number
  /** Hard cap counting everything, tool waits included (permission-asking modes: 600000). */
  totalCapMs?: number
  signal: AbortSignal
  tools: readonly { name: string; scriptName: string; aliases: string[] }[]
  callTool: (name: string, input: unknown) => Promise<unknown>
  /** What describeTool(name) resolves for a tool; computed before the run, as the context can't call back synchronously. */
  describeTool?: (name: string) => ReplToolDescription | undefined
  searchTools?: (query: string, max?: number) => unknown
  /** Script run once in each new context before its first script (helper globals). */
  prelude?: string
  /**
   * The async lane: the next queued script starts once this one ends or has
   * run this long (official replDetachAfterMs), so the two overlap.
   */
  detachAfterMs?: number
  /** Called when detachAfterMs passes with the script still running, as the next one is let start. */
  onDetach?: () => void
  /** Called when the script starts, after the scripts queued before it let it. */
  onStart?: () => void
  /** The async-lane eval number, which running() marks as self. */
  evalId?: number
  /** The error for a signal abort, read as the signal fires; INTERRUPTED when it gives none. */
  interruptedError?: () => string | undefined
  /** The error at the wall-clock limit; replTotalCapMessage when not given. */
  totalCapError?: (ms: number) => string
  /** Ends the script with its error, as the wall-clock limit does. */
  failure?: Promise<string>
  /** Awaited once the script returns or throws; its lines follow what the script wrote to stderr. */
  onScriptEnd?: (failed: boolean) => Promise<string[]>
}

export type ReplToolDescription = {
  description: string
  inputSchema: Record<string, unknown>
}

export type ReplRunResult = {
  /** Wrapped, escaped and truncated `<repl-output>` text. */
  output: string
  /** What the script logged (self.log) and what its timers reported on stderr, each elided to the part cap. */
  stdout?: string
  stderr?: string
  /** Inspected last-expression value. */
  value?: string
  error?: string
  timedOut?: boolean
  interrupted?: boolean
  /** This run started in a fresh context because the previous one was lost. */
  contextReset?: boolean
}

export type ReplExecutor = {
  run(code: string, o: ReplRunOptions): Promise<ReplRunResult>
  /** The rows scripts' running() gives from now on. */
  publishRunning(rows: ReplRunningRow[]): void
  interrupt(): void
  release(): void
  /**
   * The globals scripts defined in the live context (not the built-in, helper
   * or tool ones); undefined when no context is live or it doesn't answer.
   * Never starts a Worker.
   */
  scriptGlobalNames(): Promise<string[] | undefined>
}

/** How long scriptGlobalNames waits for a context busy in a synchronous loop. */
const GLOBALS_REPLY_MS = 1_000

export const REPL_DEFAULT_TIMEOUT_MS = 30_000
export const REPL_MAX_TIMEOUT_MS = 600_000
/** Per-part cap (DVn in 2.1.325). */
export const REPL_OUTPUT_PART_CHARS = 30_000
/** REPL maxResultSizeChars in 2.1.325. */
export const REPL_OUTPUT_TOTAL_CHARS = 100_000

/**
 * Official 325 `Ju()` default branch (an Esc, a turn interrupt, /clear): the
 * model sees the error's stack head, `Error: REPL execution interrupted`.
 * Its `taskStop`/`session` texts need per-eval tasks, which we don't have.
 */
const INTERRUPTED = 'Error: REPL execution interrupted'
const CONTEXT_LOST = 'Stopped: another script in this REPL context was stopped, and the context went with it'
const SYNTAX_ERROR = 'Syntax error, so nothing ran'
const IMPORT_KINDS: Record<string, string> = {
  'import-statement': 'import',
  'dynamic-import': 'import',
  'require-call': 'require',
}

function headLength(max: number): number {
  return Math.floor(max * 0.6)
}

/** Official `en()`: keep the first 60% and the last 40% of `max`. */
export function elide(text: string, max: number): string {
  if (text.length <= max) return text
  const head = text.slice(0, headLength(max))
  const tail = text.slice(text.length - (max - headLength(max)))
  return `${head}\n... [${text.length - head.length - tail.length} chars elided] ...\n${tail}`
}

/** Keeps exactly what `elide(all, max)` needs without holding the whole stream. */
class HeadTail {
  private head = ''
  private tail = ''
  private total = 0
  constructor(private readonly max: number) {}
  push(text: string): void {
    this.total += text.length
    const room = headLength(this.max) - this.head.length
    if (room > 0) {
      this.head += text.slice(0, room)
      text = text.slice(room)
    }
    if (text) this.tail = (this.tail + text).slice(-(this.max - headLength(this.max)))
  }
  render(): string {
    const elided = this.total - this.head.length - this.tail.length
    const text = elided > 0 ? `${this.head}\n... [${elided} chars elided] ...\n${this.tail}` : this.head + this.tail
    return text.endsWith('\n') ? text.slice(0, -1) : text
  }
  get empty(): boolean {
    return this.total === 0
  }
}

function escapeOutput(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * Official 325 script-time timeout: the model sees the error's stack head,
 * `Error: <message>` (its `Timed out after …` line is only shown to people).
 */
export function replTimeoutMessage(ms: number): string {
  return `Error: REPL execution timed out after ${ms}ms of script time (inner tool calls excluded). Script may still be running \u2014 avoid unbounded awaits.`
}

export function replTotalCapMessage(ms: number): string {
  return `REPL execution exceeded hard wall-clock limit of ${ms}ms. An inner tool call may be hung \u2014 try a shorter timeout on the tool itself, or split the work.`
}

/** Escaped text of `raw`, elided as needed so it is at most `budget` chars. */
function fitEscaped(raw: string, budget: number, cap: number): string {
  let max = Math.min(raw.length, cap)
  for (let i = 0; i < 8; i++) {
    const escaped = escapeOutput(elide(raw, max))
    if (escaped.length <= budget) return escaped
    max = Math.max(0, Math.floor((max * budget) / escaped.length) - 64)
  }
  return escapeOutput(elide(raw, 0))
}

/** stdout/stderr arrive already elided to the part cap (console buffers); error and value are capped here. */
export function formatReplOutput(parts: { stdout?: string; stderr?: string; error?: string; value?: string }): string {
  const items: { tag: string; text: string; cap: number }[] = []
  if (parts.stdout) items.push({ tag: 'log', text: parts.stdout, cap: Infinity })
  if (parts.stderr) items.push({ tag: 'log', text: `[stderr] ${parts.stderr}`, cap: Infinity })
  if (parts.error !== undefined) items.push({ tag: 'error', text: parts.error, cap: REPL_OUTPUT_PART_CHARS })
  else items.push({ tag: 'result', text: parts.value ?? '', cap: REPL_OUTPUT_PART_CHARS })
  const render = (budget: number) =>
    items
      .map(({ tag, text, cap }) => {
        const escaped = fitEscaped(text, budget, cap)
        return escaped === '' ? `<${tag}/>` : `<${tag}>${escaped}</${tag}>`
      })
      .join('\n')
  let body = render(Infinity)
  // Escaping can grow a part past its share; shrink every part to fit the total.
  if (body.length > REPL_OUTPUT_TOTAL_CHARS) body = render(Math.floor(REPL_OUTPUT_TOTAL_CHARS / items.length) - 32)
  return `<repl-output>\n${body}\n</repl-output>`
}

let transpiler: InstanceType<typeof Bun.Transpiler> | undefined

/** Top-level await and last-expression value via Bun's REPL transform; import/require rejected before anything runs. */
export function transpileReplCode(source: string): { code: string } | { error: string } {
  transpiler ??= new Bun.Transpiler({ loader: 'js', replMode: true })
  const stripped = source.replace(/^#!.*/, '')
  let code: string
  try {
    code = transpiler.transformSync(stripped)
  } catch (error) {
    return { error: `${SYNTAX_ERROR}\n${error instanceof Error ? error.message : String(error)}` }
  }
  let imports: { kind: string }[] = []
  try {
    imports = transpiler.scanImports(stripped)
  } catch {
    // transformSync already accepted the code; the sealed context still refuses imports.
  }
  for (const { kind } of imports) {
    const label = IMPORT_KINDS[kind]
    if (!label) continue
    return {
      error:
        `Module loading (${label}) is not available in REPL \u2014 the vm context is sealed. ` +
        "Use the tool globals instead: await Read({file_path: '...'}), await Glob({pattern: '...'}), the registered shell tool, etc.",
    }
  }
  return { code }
}

function toReplyJson(value: unknown): string {
  if (value === undefined) return '{"ok":true}'
  try {
    const json = JSON.stringify(value)
    if (json !== undefined) return `{"ok":true,"value":${json}}`
  } catch {
    // Not JSON-safe (cycle, BigInt): fall back to the string form below.
  }
  return JSON.stringify({ ok: true, value: String(value) })
}

function toErrorJson(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const reply: Record<string, unknown> = { ok: false, message }
  if (error instanceof Error && error.name !== 'Error') reply.name = error.name
  const detail = error && typeof error === 'object' ? (error as { detail?: unknown }).detail : undefined
  if (detail !== undefined) {
    try {
      reply.detail = JSON.parse(JSON.stringify(detail))
    } catch {
      reply.detail = String(detail)
    }
  }
  return JSON.stringify(reply)
}

let workerUrl: string | undefined

function startWorker(): Worker {
  workerUrl ??= URL.createObjectURL(new Blob([`(${replWorkerMain.toString()})()`], { type: 'text/javascript' }))
  return new Worker(workerUrl)
}

type RunEnd = { value?: string; error?: string; timedOut?: boolean; interrupted?: boolean; notes?: string[] }

type ActiveRun = {
  id: number
  onMessage(message: ReplWorkerMessage): void
  finish(end: RunEnd): void
}

function clampTimeout(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms)) return REPL_DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(1, Math.floor(ms)), REPL_MAX_TIMEOUT_MS)
}

/**
 * One persistent vm context in a Worker. A timeout, abort or interrupt
 * terminates the Worker, which is the only way to stop a synchronous loop;
 * the next run starts a fresh context and reports `contextReset`.
 */
export function createReplExecutor({ onAbortEval }: { onAbortEval?: (id: number) => void } = {}): ReplExecutor {
  let worker: Worker | undefined
  let runningJson = '[]'
  let lost = false
  let released = false
  let nextRunId = 1
  // More than one when a detached script runs beside the next (async lane).
  const active = new Map<number, ActiveRun>()
  let queue: Promise<unknown> = Promise.resolve()

  let nextGlobalsId = 1
  const globalsReplies = new Map<number, (names: string[] | undefined) => void>()

  const finishAll = (end: RunEnd) => {
    for (const run of [...active.values()]) run.finish(end)
  }

  const kill = (others: RunEnd = { error: CONTEXT_LOST, interrupted: true }) => {
    if (!worker) return
    worker.terminate()
    worker = undefined
    lost = true
    // Scripts sharing the context can't outlive it.
    finishAll(others)
    for (const reply of [...globalsReplies.values()]) reply(undefined)
  }

  const ensureWorker = (): { worker: Worker; contextReset: boolean } => {
    if (worker) return { worker, contextReset: false }
    const contextReset = lost
    lost = false
    const started = startWorker()
    // An idle context must not keep the CLI alive; a run holds its own timers.
    ;(started as Worker & { unref?: () => void }).unref?.()
    started.onmessage = (event: MessageEvent<ReplWorkerMessage>) => {
      if (worker !== started) return
      const message = event.data
      if (message.t === 'globals') globalsReplies.get(message.id)?.(message.names)
      else if (message.t === 'abort') onAbortEval?.(message.id)
      else active.get(message.runId)?.onMessage(message)
    }
    started.onerror = (event: ErrorEvent) => {
      if (worker !== started) return
      event.preventDefault?.()
      finishAll({ error: `REPL worker crashed: ${event.message}` })
      kill()
    }
    if (runningJson !== '[]') started.postMessage({ t: 'running', json: runningJson } satisfies ReplHostMessage)
    worker = started
    return { worker: started, contextReset }
  }

  const execute = (code: string, o: ReplRunOptions): Promise<ReplRunResult> => {
    if (released) return Promise.reject(new Error('REPL executor released'))
    if (o.signal.aborted) {
      const error = o.interruptedError?.() ?? INTERRUPTED
      return Promise.resolve({ output: formatReplOutput({ error }), error, interrupted: true })
    }
    const transpiled = transpileReplCode(code)
    if ('error' in transpiled) return Promise.resolve({ output: formatReplOutput({ error: transpiled.error }), error: transpiled.error })

    const { worker: target, contextReset } = ensureWorker()
    const timeoutMs = clampTimeout(o.timeoutMs)
    const stdout = new HeadTail(REPL_OUTPUT_PART_CHARS)
    const stderr = new HeadTail(REPL_OUTPUT_PART_CHARS)
    const specs: ReplWorkerToolSpec[] = o.tools.map(tool => ({
      name: tool.name,
      names: [...new Set([tool.scriptName, tool.name, ...tool.aliases])],
    }))
    const descriptions: Record<string, ReplToolDescription> = {}
    for (const tool of o.tools) {
      try {
        const description = o.describeTool?.(tool.name)
        if (description !== undefined) descriptions[tool.name] = description
      } catch {
        // A tool without a description is still callable.
      }
    }

    return new Promise<ReplRunResult>(resolve => {
      const id = nextRunId++
      // Script time: wall time while no tool call is pending.
      let used = 0
      let since: number | undefined = performance.now()
      let pendingCalls = 0
      let budgetTimer: ReturnType<typeof setTimeout> | undefined
      let capTimer: ReturnType<typeof setTimeout> | undefined
      let settled = false

      const arm = () => {
        clearTimeout(budgetTimer)
        if (since === undefined) return
        const remaining = timeoutMs - used - (performance.now() - since)
        budgetTimer = setTimeout(() => run.finish({ error: replTimeoutMessage(timeoutMs), timedOut: true }), Math.max(0, remaining))
      }
      const pause = () => {
        if (since !== undefined) used += performance.now() - since
        since = undefined
        clearTimeout(budgetTimer)
      }
      const resume = () => {
        since = performance.now()
        arm()
      }
      const onAbort = () => run.finish({ error: o.interruptedError?.() ?? INTERRUPTED, interrupted: true })

      const answer = (callId: number, work: () => unknown) => {
        if (pendingCalls++ === 0) pause()
        void Promise.resolve()
          .then(work)
          .then(toReplyJson, toErrorJson)
          .then(json => {
            if (settled || worker !== target) return
            if (--pendingCalls === 0) resume()
            target.postMessage({ t: 'reply', id: callId, json } satisfies ReplHostMessage)
          })
      }

      const run: ActiveRun = {
        id,
        onMessage(message) {
          if (settled) return
          if (message.t === 'log') (message.stream === 1 ? stderr : stdout).push(`${message.text}\n`)
          else if (message.t === 'done') {
            const end = { value: message.value, error: message.error }
            if (!o.onScriptEnd) run.finish(end)
            else
              void o.onScriptEnd(end.error !== undefined).then(
                notes => run.finish({ ...end, notes }),
                () => run.finish(end),
              )
          }
          else if (message.t === 'call') {
            const input = message.input === undefined ? undefined : JSON.parse(message.input)
            if (message.kind === 'search') {
              answer(message.id, () => {
                if (!o.searchTools) throw new Error('searchTools is not available in this REPL call')
                const { query, max } = input as { query: string; max?: number }
                return o.searchTools(query, max)
              })
            } else answer(message.id, () => o.callTool(message.name, input))
          }
        },
        finish(end) {
          if (settled) return
          settled = true
          clearTimeout(budgetTimer)
          clearTimeout(capTimer)
          o.signal.removeEventListener('abort', onAbort)
          active.delete(id)
          // The only way to stop the script; the context goes with it.
          if (end.timedOut || end.interrupted) kill()
          const logged = stdout.empty ? '' : stdout.render()
          const errors = [...(stderr.empty ? [] : [stderr.render()]), ...(end.notes ?? [])].join('\n')
          const output = formatReplOutput({
            stdout: logged || undefined,
            stderr: errors || undefined,
            error: end.error,
            value: end.value,
          })
          resolve({
            output,
            stdout: logged,
            stderr: errors,
            ...(end.value === undefined ? {} : { value: end.value }),
            ...(end.error === undefined ? {} : { error: end.error }),
            ...(end.timedOut ? { timedOut: true } : {}),
            ...(end.interrupted ? { interrupted: true } : {}),
            ...(contextReset ? { contextReset: true } : {}),
          })
        },
      }

      active.set(id, run)
      o.signal.addEventListener('abort', onAbort, { once: true })
      if (o.totalCapMs !== undefined) {
        const cap = Math.max(1, o.totalCapMs)
        capTimer = setTimeout(() => run.finish({ error: o.totalCapError?.(cap) ?? replTotalCapMessage(cap), timedOut: true }), cap)
      }
      void o.failure?.then(error => run.finish({ error, timedOut: true }))
      arm()
      o.onStart?.()
      target.postMessage({
        t: 'run',
        runId: id,
        code: transpiled.code,
        tools: JSON.stringify(specs),
        descriptions: JSON.stringify(descriptions),
        search: o.searchTools !== undefined,
        ...(o.prelude === undefined ? {} : { prelude: o.prelude }),
        ...(o.evalId === undefined ? {} : { evalId: o.evalId }),
      } satisfies ReplHostMessage)
    })
  }

  return {
    run(code, o) {
      let started!: () => void
      const start = new Promise<void>(resolve => (started = resolve))
      const result = queue.then(() => execute(code, { ...o, onStart: () => (started(), o.onStart?.()) }))
      let done = false
      const ended = result.then(
        () => void (done = true),
        () => void (done = true),
      )
      const detach = o.detachAfterMs
      queue =
        detach === undefined
          ? ended
          : Promise.race([
              ended,
              start.then(
                () =>
                  new Promise<void>(resolve => {
                    const timer = setTimeout(() => {
                      if (!done) o.onDetach?.()
                      resolve()
                    }, Math.max(0, detach))
                    ;(timer as { unref?: () => void }).unref?.()
                  }),
              ),
            ])
      return result
    },
    interrupt() {
      kill({ error: INTERRUPTED, interrupted: true })
    },
    scriptGlobalNames() {
      const target = worker
      if (!target) return Promise.resolve(undefined)
      return new Promise(resolve => {
        const id = nextGlobalsId++
        const timer = setTimeout(() => reply(undefined), GLOBALS_REPLY_MS)
        ;(timer as { unref?: () => void }).unref?.()
        const reply = (names: string[] | undefined) => {
          clearTimeout(timer)
          globalsReplies.delete(id)
          resolve(names)
        }
        globalsReplies.set(id, reply)
        target.postMessage({ t: 'globals', id } satisfies ReplHostMessage)
      })
    },
    publishRunning(rows) {
      runningJson = JSON.stringify(rows)
      worker?.postMessage({ t: 'running', json: runningJson } satisfies ReplHostMessage)
    },
    release() {
      released = true
      kill({ error: INTERRUPTED, interrupted: true })
    },
  }
}
