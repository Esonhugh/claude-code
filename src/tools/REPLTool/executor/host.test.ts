import { afterEach, describe, expect, test } from 'bun:test'
import {
  createReplExecutor,
  elide,
  formatReplOutput,
  REPL_OUTPUT_PART_CHARS,
  REPL_OUTPUT_TOTAL_CHARS,
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
    expect(result.error).toBe('Timed out after 0.2s, not counting time spent in tool calls')
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

  test('aborting the signal interrupts the run', async () => {
    const controller = new AbortController()
    const { run } = setup()
    const pending = run('while (true) {}', { signal: controller.signal, timeoutMs: 10_000 })
    await sleep(100)
    controller.abort()
    const result = await pending
    expect(result).toMatchObject({ interrupted: true, error: 'Interrupted' })
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
