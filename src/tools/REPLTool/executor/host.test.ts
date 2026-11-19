import { afterEach, describe, expect, test } from 'bun:test'
import {
  createReplExecutor,
  elide,
  formatReplOutput,
  REPL_OUTPUT_PART_CHARS,
  REPL_OUTPUT_TOTAL_CHARS,
  scriptDeadline,
  type DeadlineClock,
  type ReplExecutor,
  type ReplRunOptions,
} from './host.js'

const executors: ReplExecutor[] = []
afterEach(() => {
  for (const executor of executors.splice(0)) executor.release()
})

function setup(overrides: Partial<ReplRunOptions> = {}) {
  const executor = createReplExecutor()
  executors.push(executor)
  const calls: { name: string; input: unknown }[] = []
  const options: ReplRunOptions = {
    signal: new AbortController().signal,
    tools: [
      { name: 'Read', scriptName: 'Read', aliases: [] },
      { name: 'mcp__srv__do-it', scriptName: 'mcp__srv__do_it', aliases: [] },
    ],
    callTool: async (name, input) => {
      calls.push({ name, input })
      return { name, input }
    },
    ...overrides,
  }
  return { executor, calls, run: (code: string, extra: Partial<ReplRunOptions> = {}) => executor.run(code, { ...options, ...extra }) }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('REPL executor', () => {
  test('top-level await and the last expression value', async () => {
    const { run } = setup()
    const result = await run('const a = await Promise.resolve(2)\na * 3')
    expect(result.value).toBe('6')
    expect(result.output).toBe('<repl-output>\n<result>6</result>\n</repl-output>')
    expect((await run('for (const s of []) {}')).output).toBe('<repl-output>\n<result/>\n</repl-output>')
  })

  test('variables and functions persist across runs', async () => {
    const { run } = setup()
    await run('const total = 40\nfunction add(n) { return total + n }\nclass K { v = 1 }')
    expect((await run('add(2)')).value).toBe('42')
    expect((await run('new K().v')).value).toBe('1')
  })

  test('import and require are rejected before running', async () => {
    const { run } = setup()
    for (const code of ['import fs from "fs"\nglobalThis.ran = 1', 'await import("fs")', 'require("fs")']) {
      const result = await run(code)
      expect(result.error).toMatch(/^Module loading \((import|require)\) is not available in REPL \u2014 the vm context is sealed\./)
    }
    expect((await run('typeof ran')).value).toBe('undefined')
    // A computed specifier escapes scanImports; the import() hook still refuses it.
    expect((await run('const spec = "fs"\nawait import(spec)')).error).toContain('Module loading (import) is not available in REPL')
  })

  test('eval, new Function and the worker globals are unavailable', async () => {
    const { run } = setup()
    expect((await run('eval("1")')).error).toContain('EvalError')
    expect((await run('new Function("return 1")')).error).toContain('EvalError')
    expect((await run('(async () => {}).constructor("return 1")')).error).toContain('EvalError')
    expect((await run('[typeof process, typeof Bun, typeof globalThis.require, typeof postMessage]')).value).toBe(
      "[ 'undefined', 'undefined', 'undefined', 'undefined' ]",
    )
    expect((await run('Object.isFrozen(Array.prototype)')).value).toBe('true')
  })

  test('tool bridge round-trips JSON values and runs calls concurrently', async () => {
    let inFlight = 0
    let peak = 0
    const { run } = setup({
      callTool: async (name, input) => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await sleep(20)
        inFlight--
        return { name, input }
      },
    })
    const result = await run(
      'const [a, b] = await Promise.all([Read({file_path: "a"}), mcp__srv__do_it({n: 1})]);\n[a.input.file_path, b.name, typeof tools.Read, tools.list()]',
    )
    expect(result.value).toBe("[ 'a', 'mcp__srv__do-it', 'function', [ 'Read', 'mcp__srv__do-it' ] ]")
    expect(peak).toBe(2)
  })

  test('tool errors reject inside the script with name and detail', async () => {
    class McpToolError extends Error {
      override name = 'McpToolError'
      detail = { code: 7 }
    }
    const { run } = setup({ callTool: async () => { throw new McpToolError('boom') } })
    const result = await run('let caught\ntry { await Read({}) } catch (e) { caught = [e.name, e.message, e.detail.code] }\ncaught')
    expect(result.value).toBe("[ 'McpToolError', 'boom', 7 ]")
  })

  test('describeTool and searchTools reach the host', async () => {
    const { run } = setup({
      describeTool: name => (name === 'Read' ? { description: 'Reads a file', inputSchema: { type: 'object' } } : undefined),
      searchTools: query => [{ name: 'Read', query }],
    })
    expect((await run('JSON.stringify([await describeTool("Read"), await describeTool("Nope")])')).value).toBe(
      '[{"name":"Read","description":"Reads a file","inputSchema":{"type":"object"}},{"error":"No tool is named Nope: tools.list() gives the names"}]',
    )
    expect((await run('(await searchTools("file"))[0].query')).value).toBe('file')
  })

  test('time spent waiting on tools does not count toward the timeout', async () => {
    const { run } = setup({ callTool: async () => { await sleep(400); return 1 } })
    const result = await run('await Read({}); await Read({}); "done"', { timeoutMs: 250 })
    expect(result.timedOut).toBeUndefined()
    expect(result.value).toBe('done')
  })

  test('an infinite loop is stopped and the next run reports a fresh context', async () => {
    const { run } = setup()
    await run('const kept = 1')
    const started = performance.now()
    const result = await run('while (true) {}', { timeoutMs: 200 })
    expect(performance.now() - started).toBeLessThan(1500)
    expect(result.timedOut).toBe(true)
    expect(result.error).toBe(
      'Error: REPL execution timed out after 200ms of script time (inner tool calls excluded). Script may still be running \u2014 avoid unbounded awaits.',
    )
    const next = await run('typeof kept')
    expect(next.contextReset).toBe(true)
    expect(next.value).toBe('undefined')
    expect((await run('1')).contextReset).toBeUndefined()
  })

  test('totalCapMs counts tool waits', async () => {
    const { run } = setup({ callTool: () => new Promise(() => {}) })
    const result = await run('await Read({})', { totalCapMs: 150 })
    expect(result.timedOut).toBe(true)
    expect(result.error).toContain('hard wall-clock limit of 150ms')
  })

  test('the host words the wall-clock error and can end the run with its own', async () => {
    const { run } = setup({ callTool: () => new Promise(() => {}) })
    const capped = await run('await Read({})', { totalCapMs: 100, totalCapError: ms => `cap ${ms}` })
    expect(capped).toMatchObject({ error: 'cap 100', timedOut: true })
    const failed = await run('await Read({})', { failure: sleep(50).then(() => 'hung') })
    expect(failed).toMatchObject({ error: 'hung', timedOut: true, contextReset: true })
  })

  test('aborting the signal interrupts the run', async () => {
    const controller = new AbortController()
    const { run } = setup()
    const pending = run('while (true) {}', { signal: controller.signal, timeoutMs: 10_000 })
    await sleep(100)
    controller.abort()
    const result = await pending
    expect(result).toMatchObject({ interrupted: true, error: 'Error: REPL execution interrupted' })
    expect((await run('1', { signal: new AbortController().signal })).contextReset).toBe(true)
    expect((await run('1', { signal: controller.signal })).interrupted).toBe(true)
  })

  test('interrupt clears timers and ignores pending tool results', async () => {
    let resolveCall: (value: unknown) => void = () => {}
    const { executor, run } = setup({ callTool: () => new Promise(resolve => { resolveCall = resolve }) })
    const pending = run('setInterval(() => self.log("tick"), 10)\nawait Read({})\n"never"')
    await sleep(60)
    executor.interrupt()
    const result = await pending
    expect(result.interrupted).toBe(true)
    expect(result.output).toContain('tick')
    resolveCall('late')
    const next = await run('typeof setInterval')
    expect(next.contextReset).toBe(true)
    expect(next.output).not.toContain('tick')
  })

  test('timers that outlive a run are cleared at its end', async () => {
    const { run } = setup()
    await run('globalThis.hits = 0\nsetInterval(() => hits++, 5)\nsetTimeout(() => hits += 100, 30)')
    await sleep(80)
    expect((await run('hits')).value).toBe('0')
    expect((await run('await new Promise(r => setTimeout(() => r(7), 10))')).value).toBe('7')
  })

  test('self.log output is escaped and uncaught timer errors go to stderr', async () => {
    const { run } = setup()
    const result = await run('self.log("<b>&</b>", {x: 1})\nsetTimeout(() => { throw new Error("bad") }, 0)\nawait new Promise(r => setTimeout(r, 10))\n"<ok>"')
    expect(result.output).toBe(
      '<repl-output>\n<log>&lt;b&gt;&amp;&lt;/b&gt; { x: 1 }</log>\n<log>[stderr] Uncaught Error: bad</log>\n<result>&lt;ok&gt;</result>\n</repl-output>',
    )
  })

  test('console goes to a ring that console.tail reads back, across runs', async () => {
    const { run } = setup()
    const first = await run('for (let i = 0; i < 1005; i++) console.log("n", i)\nconsole.error("last")')
    expect(first.output).not.toContain('last')
    expect((await run('console.tail(2)')).value).toBe('n 1004\nlast')
    expect((await run('console.tail(5000).split("\\n").length')).value).toBe('1000')
    expect((await run('[console.buffer().split("\\n").length, console.dropped()]')).value).toBe('[ 1000, 6 ]')
  })

  test('promises inside a returned object or array are awaited', async () => {
    const { run } = setup()
    expect((await run('({a: Promise.resolve(1), b: 2, c: {then: r => r(3)}})')).value).toBe('{ a: 1, b: 2, c: 3 }')
    expect((await run('[Promise.resolve("x"), 1]')).value).toBe("[ 'x', 1 ]")
  })

  test('the prelude runs once per context', async () => {
    const { run } = setup({ prelude: 'globalThis.runs = (globalThis.runs ?? 0) + 1' })
    await run('1')
    expect((await run('runs')).value).toBe('1')
  })

  test('long output is elided per part and in total', async () => {
    const { run } = setup()
    const result = await run('for (let i = 0; i < 5000; i++) self.log("line " + i + " " + "x".repeat(20))\n"<".repeat(80000)')
    expect(result.output.length).toBeLessThanOrEqual(REPL_OUTPUT_TOTAL_CHARS + 40)
    expect(result.output).toMatch(/<log>line 0 [\s\S]*\n\.\.\. \[\d+ chars elided\] \.\.\.\n[\s\S]*line 4999 x+<\/log>/)
    expect(result.output).toMatch(/<result>(&lt;)+\n\.\.\. \[\d+ chars elided\] \.\.\.\n(&lt;)+<\/result>/)
  })

  test('syntax errors report without running', async () => {
    const { run } = setup()
    expect((await run('const = 1')).error).toStartWith('Syntax error, so nothing ran\n')
  })

  test('errorNote follows the error of a script that threw or was stopped, not a syntax error or a stop report', async () => {
    const errorNote = (stopped: boolean) => (stopped ? 'stopped' : 'threw')
    const { run } = setup({ errorNote })
    expect((await run('throw new Error("boom")')).error).toBe('Error: boom\nthrew')
    expect((await run('while (true) {}', { timeoutMs: 100 })).error).toEndWith('avoid unbounded awaits.\nstopped')
    expect((await run('const = 1')).error).not.toContain('threw')
    expect((await run('1')).value).toBe('1')
    const controller = new AbortController()
    const plain = run('await new Promise(() => {})', { signal: controller.signal })
    await sleep(50)
    controller.abort()
    expect((await plain).error).toBe('Error: REPL execution interrupted\nstopped')
    const reported = new AbortController()
    const pending = run('await new Promise(() => {})', { signal: reported.signal, interruptedError: () => 'report' })
    await sleep(50)
    reported.abort()
    expect((await pending).error).toBe('report')
  })
})

describe('REPL executor, async lane', () => {
  test('a script past detachAfterMs lets the next start; they share variables and keep their own logs and calls', async () => {
    const { run, calls } = setup()
    const first = run("self.log('one'); shared = 1; await new Promise(r => setTimeout(r, 300)); await Read({who: 1}); shared", { detachAfterMs: 50 })
    const second = run("self.log('two'); shared = 2; await Read({who: 2}); shared", { detachAfterMs: 50 })
    const done = await second
    expect(done.value).toBe('2')
    expect(done.stdout).toBe('two')
    const late = await first
    expect(late.value).toBe('2')
    expect(late.stdout).toBe('one')
    expect(calls.map(call => call.input)).toEqual([{ who: 2 }, { who: 1 }])
  })

  test('onDetach fires once detachAfterMs passes with the script still running, not for one that ended first', async () => {
    const { run } = setup()
    const detached: string[] = []
    const slow = run('await new Promise(r => setTimeout(r, 200)); 1', { detachAfterMs: 30, onDetach: () => detached.push('slow') })
    const quick = run('2', { detachAfterMs: 30, onDetach: () => detached.push('quick') })
    await Promise.all([slow, quick])
    await new Promise(r => setTimeout(r, 60))
    expect(detached).toEqual(['slow'])
  })

  test('without detachAfterMs scripts still run one after another', async () => {
    const { run } = setup()
    const order: string[] = []
    const first = run('await new Promise(r => setTimeout(r, 150)); 1').then(() => order.push('first'))
    const second = run('2').then(() => order.push('second'))
    await Promise.all([first, second])
    expect(order).toEqual(['first', 'second'])
  })

  test("a script's timers end with it, another script's keep running", async () => {
    const { run } = setup()
    const long = run("ticks = 0; setInterval(() => ticks++, 10); await new Promise(r => setTimeout(r, 200)); ticks > 5", { detachAfterMs: 20 })
    await run("setInterval(() => {}, 10); 'short'", { detachAfterMs: 20 })
    expect((await long).value).toBe('true')
  })

  test('stopping one script stops the scripts sharing its context', async () => {
    const { run } = setup()
    const controller = new AbortController()
    const detached = run('await new Promise(r => setTimeout(r, 5000)); 1', { detachAfterMs: 20 })
    await sleep(40)
    const stopped = run('await new Promise(r => setTimeout(r, 5000)); 2', { signal: controller.signal })
    await sleep(40)
    controller.abort()
    expect((await stopped).interrupted).toBe(true)
    const other = await detached
    expect(other.interrupted).toBe(true)
    expect(other.error).toContain('another script')
  })

  test('interrupt stops every running script', async () => {
    const { executor, run } = setup()
    const a = run('await new Promise(r => setTimeout(r, 5000)); 1', { detachAfterMs: 10 })
    await sleep(30)
    const b = run('await new Promise(r => setTimeout(r, 5000)); 2', { detachAfterMs: 10 })
    await sleep(30)
    executor.interrupt()
    expect((await a).error).toBe('Error: REPL execution interrupted')
    expect((await b).error).toBe('Error: REPL execution interrupted')
  })
})

describe('REPL executor, scriptGlobalNames', () => {
  test('lists what scripts defined, not built-in, helper or tool globals, and starts no Worker', async () => {
    const { executor, run } = setup({ prelude: 'var helperFn = () => 1' })
    expect(await executor.scriptGlobalNames()).toBeUndefined()
    await run('const kept = 1; function named() {}; class Klass {}; implicit = 2; helperFn()')
    const names = await executor.scriptGlobalNames()
    expect(names?.sort()).toEqual(['Klass', 'implicit', 'kept', 'named'])
    executor.interrupt()
    expect(await executor.scriptGlobalNames()).toBeUndefined()
  })

  test('a context busy in a synchronous loop gives undefined', async () => {
    const { executor, run } = setup()
    const busy = run('x = 1; while (true) {}', { timeoutMs: 3000 })
    await sleep(100)
    expect(await executor.scriptGlobalNames()).toBeUndefined()
    executor.interrupt()
    await busy
  })
})

describe('scriptDeadline (official 325 ic)', () => {
  function fakeClock() {
    let now = 0
    let timer: { at: number; fire: () => void } | undefined
    const clock: DeadlineClock = {
      now: () => now,
      setTimeout: (fire, ms) => {
        const own = { at: now + ms, fire }
        timer = own
        return () => {
          if (timer === own) timer = undefined
        }
      },
    }
    // Moves the clock to `to` and fires the timer if it is due by then, however late;
    // with `stalled` the timer has not had its turn yet.
    const advance = (to: number, stalled = false) => {
      now = to
      const due = stalled ? undefined : timer
      if (due && due.at <= now) {
        timer = undefined
        due.fire()
      }
    }
    return { clock, advance, armedFor: () => (timer ? timer.at - now : undefined) }
  }

  test('an on-time timer ends the budget', () => {
    const { clock, advance } = fakeClock()
    let expired = 0
    scriptDeadline(1_000, () => expired++, clock).start()
    advance(1_000)
    expect(expired).toBe(1)
  })

  test('a timer more than 1000 ms late gives 5000 ms more once', () => {
    const { clock, advance, armedFor } = fakeClock()
    let expired = 0
    scriptDeadline(1_000, () => expired++, clock).start()
    advance(2_001)
    expect(expired).toBe(0)
    expect(armedFor()).toBe(5_000)
    advance(9_000)
    expect(expired).toBe(1)
  })

  test('a timer at most 1000 ms late ends the budget', () => {
    const { clock, advance } = fakeClock()
    let expired = 0
    scriptDeadline(1_000, () => expired++, clock).start()
    advance(2_000)
    expect(expired).toBe(1)
  })

  test('tool calls pause it, and a stall seen at a call start gets the grace too', () => {
    const { clock, advance, armedFor } = fakeClock()
    let expired = 0
    const deadline = scriptDeadline(1_000, () => expired++, clock)
    deadline.start()
    advance(400)
    deadline.onToolStart()
    expect(armedFor()).toBeUndefined()
    advance(10_000)
    deadline.onToolEnd()
    expect(armedFor()).toBe(600)
    // The timer is due at 10600 but the loop stalls; a call starting at 12000 finds it.
    advance(12_000, true)
    deadline.onToolStart()
    expect(armedFor()).toBeUndefined()
    advance(13_000)
    deadline.onToolEnd()
    expect(armedFor()).toBe(5_000)
    // The grace is given once: a second late timer ends the budget.
    advance(20_000)
    expect(expired).toBe(1)
  })
})

describe('formatReplOutput', () => {
  test('elide keeps 60% head and 40% tail', () => {
    const text = 'a'.repeat(60) + 'b'.repeat(100) + 'c'.repeat(40)
    expect(elide(text, 100)).toBe(`${'a'.repeat(60)}\n... [100 chars elided] ...\n${'c'.repeat(40)}`)
  })

  test('error and result are capped at the part limit', () => {
    const output = formatReplOutput({ value: 'v'.repeat(REPL_OUTPUT_PART_CHARS + 10) })
    expect(output).toContain('... [10 chars elided] ...')
  })

  test('the total cap keeps entities whole', () => {
    const output = formatReplOutput({ stdout: '&'.repeat(REPL_OUTPUT_PART_CHARS), stderr: '<'.repeat(REPL_OUTPUT_PART_CHARS), value: '>'.repeat(REPL_OUTPUT_PART_CHARS) })
    expect(output.length).toBeLessThanOrEqual(REPL_OUTPUT_TOTAL_CHARS + 40)
    expect(output).not.toMatch(/&(?!amp;|lt;|gt;)/)
  })
})
