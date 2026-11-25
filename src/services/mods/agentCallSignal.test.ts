import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime, type ModRequestServices } from './runtime.js'
import type { ModInput } from './types.js'

// Observed in official 2.1.329: the text a cut `$.agent.call` resolves with.
const CUT = '[Tool call did not complete: the plugin that made it cancelled it. Nothing refused it.]'

let root: string
const runtimes: ReturnType<typeof createModsRuntime>[] = []
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'mods-agent-call-signal-')) })
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
  await rm(root, { recursive: true, force: true })
})

type HostCall = NonNullable<ReturnType<NonNullable<ModRequestServices['toolHost']>>>['call']

async function setup(call: HostCall, body: string) {
  const calls: { input: ModInput; signal: AbortSignal }[] = []
  const runtime = createModsRuntime({ services: { toolHost: () => ({
    tools: () => [],
    call: async (input, snapshot, signal, ...rest) => {
      calls.push({ input, signal })
      return call(input, snapshot, signal, ...rest)
    },
    check: async () => ({ decision: 'allow' as const }),
  }) } })
  runtimes.push(runtime)
  const entry = join(root, 'register.ts')
  await writeFile(entry, `export function register(on) {
    on('tool.call', async $ => {
      const args = { tool: 'Bash', input: { command: 'sleep 3' } }
      try { ${body} } catch (error) { return { result: { caught: true, name: error.name, message: error.message } } }
    })
  }`)
  await runtime.reconcile([{ name: 'cutter', storageId: 'cutter@test', pluginRoot: root, entrypoints: [entry] }])
  const run = () => runtime.dispatch('tool.call', {}, async () => ({ result: 'core' })) as Promise<{ result: unknown }>
  return { runtime, calls, run }
}

function observe(runtime: ReturnType<typeof createModsRuntime>, invoke?: (input: ModInput, next: (input: ModInput) => Promise<unknown>, signal: AbortSignal) => Promise<unknown>) {
  const seen: { aborted: boolean; reason?: unknown }[] = []
  const release = runtime.registerHostHook({ plugin: 'observer', tier: 'user', registration: { id: 1, event: 'agent.call', hasCatch: false }, invoke: async (input, next) => {
    const signal = (next as unknown as { signal: AbortSignal }).signal
    try { return invoke ? await invoke(input, next, signal) : await next(input) }
    finally { seen.push({ aborted: signal.aborted, reason: signal.reason }) }
  } })
  return { seen, release }
}

test('an already aborted signal resolves the cut and runs nothing', async () => {
  const { runtime, calls, run } = await setup(async () => ({ result: 'ran', text: 'ran' }),
    `return { result: await $.agent.call(args, { signal: AbortSignal.abort('mine') }) }`)
  const { seen, release } = observe(runtime)
  try {
    expect(await run()).toEqual({ result: { deny: CUT } })
    expect(calls).toHaveLength(0)
    expect(seen).toHaveLength(0)
  } finally { release() }
})

test('aborting mid-call cuts the tool and resolves the cut under the engine reason', async () => {
  const { runtime, calls, run } = await setup(async (_input, _snapshot, signal) => {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    return { result: 'Error: Exit code 137', text: 'Exit code 137', isError: true }
  }, `const stop = new AbortController()
      const ran = $.agent.call(args, { signal: stop.signal })
      await $.clock.sleep(20)
      stop.abort('mine')
      const value = await ran
      return { result: { value, isCut: value.deny !== undefined && stop.signal.aborted } }`)
  const { seen, release } = observe(runtime)
  try {
    expect(await run()).toEqual({ result: { value: { deny: CUT }, isCut: true } })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.signal.aborted).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.aborted).toBe(true)
    expect(seen[0]!.reason).toMatchObject({ name: 'HooksError', message: 'call-cut-by-plugin' })
  } finally { release() }
})

test('a result the tool gave before the cut is kept', async () => {
  const { runtime, run } = await setup(async () => ({ result: 'early', text: 'early' }),
    `const stop = new AbortController()
      const ran = $.agent.call(args, { signal: stop.signal })
      await $.clock.sleep(20)
      stop.abort('mine')
      return { result: await ran }`)
  // The hook holds the tool's answer until the cut has taken hold.
  const { release } = observe(runtime, async (input, next, signal) => {
    const result = await next(input)
    await new Promise(resolve => signal.aborted ? resolve(undefined) : signal.addEventListener('abort', resolve, { once: true }))
    return result
  })
  try {
    expect(await run()).toEqual({ result: { result: 'early', text: 'early' } })
  } finally { release() }
})

test('options.signal must be an AbortSignal, null included; an absent one is no option', async () => {
  const { calls, run } = await setup(async () => ({ result: 'ok', text: 'ok' }),
    `const plain = await $.agent.call(args, {})
      const unset = await $.agent.call(args, { signal: undefined })
      const one = await $.agent.call(args)
      let refused
      try { await $.agent.call(args, { signal: 'x' }) } catch (error) { refused = { name: error.name, message: error.message } }
      let nulled
      try { await $.agent.call(args, { signal: null }) } catch (error) { nulled = { name: error.name, message: error.message } }
      return { result: { plain, unset, one, refused, nulled } }`)
  expect(await run()).toEqual({ result: {
    plain: { result: 'ok', text: 'ok' },
    unset: { result: 'ok', text: 'ok' },
    one: { result: 'ok', text: 'ok' },
    refused: { name: 'HooksError', message: 'cutter: $.agent.call options.signal must be an AbortSignal' },
    nulled: { name: 'HooksError', message: 'cutter: $.agent.call options.signal must be an AbortSignal' },
  } })
  expect(calls).toHaveLength(3)
})

test('malformed arguments are refused with the official host-check text', async () => {
  const { calls, run } = await setup(async () => ({ result: 'ok', text: 'ok' }),
    `const refused = []
      for (const bad of [undefined, { tool: 1, input: {} }, { tool: 'Bash' }, { tool: 'Bash', input: 'x' }, { tool: 'Bash', input: {}, agentId: 2 }, { tool: 'Bash', input: {}, agentId: '' }])
        try { await (bad === undefined ? $.agent.call() : $.agent.call(bad)) } catch (error) { refused.push({ name: error.name, message: error.message }) }
      return { result: refused }`)
  const text = "cutter: agent.call: takes { tool, input, agentId? } (the tool's name, its arguments, an object, and the id of the agent whose call it is) (host check)"
  expect(await run()).toEqual({ result: Array(6).fill({ name: 'HooksError', message: text }) })
  expect(calls).toHaveLength(0)
})

test('a call made after its hook returned outlives the turn that hook ran in', async () => {
  const runtime = createModsRuntime({ services: { toolHost: () => ({
    tools: () => [],
    call: async (input, _snapshot, signal, _plugin, _entry, _person, ownLifetime) => {
      seen.push({ ownLifetime })
      await new Promise(resolve => setTimeout(resolve, 150))
      return { result: signal.aborted ? 'cut' : 'late', text: 'late' }
    },
    check: async () => ({ decision: 'allow' as const }),
  }) } })
  const seen: { ownLifetime?: boolean }[] = []
  runtimes.push(runtime)
  const entry = join(root, 'register.ts')
  await writeFile(entry, `let later
    export function register(on) {
      on('tool.call', async $ => {
        later = new Promise(resolve => setTimeout(() => resolve($.agent.call({ tool: 'Bash', input: { command: 'sleep 6' } })), 20))
        return { result: 'started' }
      })
      on('ui.message', async () => ({ result: await later }))
    }`)
  await runtime.reconcile([{ name: 'later', storageId: 'later@test', pluginRoot: root, entrypoints: [entry] }])
  const turn = new AbortController()
  expect(await runtime.dispatch('tool.call', {}, async () => ({ result: 'core' }), { signal: turn.signal })).toEqual({ result: 'started' })
  await new Promise(resolve => setTimeout(resolve, 60))
  turn.abort('interrupted')
  expect(await runtime.dispatch('ui.message', {}, async () => ({ result: 'core' }))).toEqual({ result: { result: 'late', text: 'late' } })
  expect(seen).toEqual([{ ownLifetime: true }])
})
