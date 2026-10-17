import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dispatchModEvent, dispatchModStream } from './dispatch.js'
import { createModsRuntime } from './runtime.js'
import { appendModCallerChain, copyModCallerChain } from './callerChain.js'
import type { ModDispatchHook } from './types.js'

type Chain = readonly (string | { plugin: string; registration: number })[]
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

test('caller history deduplicates exact frames while a standalone member excludes the whole plugin', () => {
  const first = { plugin: 'p', registration: 1 }
  const second = { plugin: 'p', registration: 2 }
  expect(appendModCallerChain([first], first)).toEqual([first])
  expect(appendModCallerChain([first], second)).toEqual([first, second])
  expect(appendModCallerChain(['p'], second)).toEqual(['p'])
  expect(appendModCallerChain([first], 'p')).toEqual([first, 'p'])
  const raw = [first]
  const saved = copyModCallerChain(raw)
  first.registration = 99
  raw.push(second)
  expect(saved).toEqual([{ plugin: 'p', registration: 1 }])
  expect(Object.isFrozen(saved)).toBe(true)
  expect(Object.isFrozen(saved[0])).toBe(true)
  expect(Object.isFrozen(raw)).toBe(false)
})

const exclusions: { label: string; chain: Chain; expected: string[] }[] = [
  { label: 'standalone excludes the whole plugin', chain: ['p'], expected: ['q:1'] },
  { label: 'one frame preserves its sibling', chain: [{ plugin: 'p', registration: 1 }], expected: ['p:2', 'q:1'] },
  { label: 'multiple deferred frames remain excluded', chain: [{ plugin: 'p', registration: 1 }, { plugin: 'q', registration: 1 }], expected: ['p:2'] },
  { label: 'an unrelated registration does not exclude a plugin', chain: [{ plugin: 'p', registration: 99 }], expected: ['p:1', 'p:2', 'q:1'] },
]
function hooks(seen: string[], event: string): ModDispatchHook[] {
  return ([['p', 1], ['p', 2], ['q', 1]] as const).map(([plugin, id]) => ({
    plugin, tier: 'user',
    registration: { id, event, hasCatch: false },
    invoke: async (input, next) => { seen.push(`${plugin}:${id}`); return next(input) },
    invokeStream: async function* (input, next) { seen.push(`${plugin}:${id}`); return yield* next(input) },
  }))
}
for (const { label, chain, expected } of exclusions) {
  test(`value caller chain: ${label}`, async () => {
    const seen: string[] = []
    expect(await dispatchModEvent({
      event: 'prompt.submit', input: { text: 'raw' }, hooks: hooks(seen, 'prompt.submit'),
      callerChain: chain, core: async input => ({ text: input.text }),
    })).toEqual({ text: 'raw' })
    expect(seen).toEqual(expected)
  })
  test(`stream caller chain: ${label}`, async () => {
    const seen: string[] = []
    const stream = dispatchModStream({
      event: 'turn.step', input: {}, hooks: hooks(seen, 'turn.step'), callerChain: chain,
      core: async function* () { yield 'chunk'; return 'result' },
    })
    expect(await stream.next()).toEqual({ done: false, value: 'chunk' })
    expect(await stream.next()).toEqual({ done: true, value: 'result' })
    expect(await stream.result).toBe('result')
    expect(seen).toEqual(expected)
  })
}

test('a real Worker receives only the last projected origin while full host chain excludes earlier frames', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-chain-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const input = []
  for (const name of ['p', 'q', 'r']) {
    const pluginRoot = join(root, name)
    await mkdir(pluginRoot)
    const entry = join(pluginRoot, 'register.ts')
    await writeFile(entry, `export function register(on) {
      on('prompt.submit', async ($,e,next) => {
        const below = await next(e);
        return {...below, text: below.text + '|' + $.plugin.name + ':' + next.origin.plugin + ':' + next.origin.tier};
      });
    }`)
    input.push({ name, storageId: `${name}@test`, pluginRoot, entrypoints: [entry] })
  }
  const runtime = createModsRuntime()
  cleanups.push(() => runtime.dispose())
  await runtime.reconcile(input)
  expect(await runtime.dispatch('prompt.submit', { text: 'raw' }, async () => ({ text: 'raw' }), {
    callerChain: ['p', 'q'],
  })).toEqual({ text: 'raw|r:q:user' })
})

test('public submit derives its private chain from the actual frame and ignores forged transport fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-chain-public-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const entry = join(root, 'register.ts')
  await writeFile(entry, `export function register(on) {
    on('ui.press', async ($,e) => ({result: await $.prompt.submit(e.input)}));
  }`)
  let carried: unknown
  const runtime = createModsRuntime({ services: { submitPrompt: async input => {
    carried = { ...input, signal: input.signal instanceof AbortSignal }
    return { text: input.text, origin: input.origin }
  } } })
  cleanups.push(() => runtime.dispose())
  await runtime.reconcile([{ name: 'sender', storageId: 'sender@test', pluginRoot: root, entrypoints: [entry] }])
  const received = await runtime.dispatch('ui.press', { input: {
    text: 'raw', asUser: true, callerChain: ['victim'], promptSubmitCallerChain: ['victim'],
    hookOrigin: ['victim'], registration: 99, dispatchId: 99,
  } }, async () => ({ result: null }), { callerChain: ['earlier'] })
  const origin = { kind: 'plugin', name: 'sender', asUser: true }
  expect(received).toEqual({ result: { text: 'raw', origin } })
  expect(carried).toEqual({
    text: 'raw', origin, signal: true,
    callerChain: ['earlier', { plugin: 'sender', registration: 1 }],
  })
})

test('nested capabilities in three actual Worker frames retain the full ordered caller history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-chain-nested-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const sources = {
    p: "on('ui.press', async ($,e) => ({result:await $.clock.now()}));",
    q: "on('clock.now', async ($,e,next) => {await $.env.get('CHAIN_PROBE');return next(e)});",
    r: "on('env.get', async ($,e,next) => {await $.prompt.submit({text:'nested'});return next(e)});",
  }
  const plugins = []
  for (const [name, handler] of Object.entries(sources)) {
    const pluginRoot = join(root, name)
    await mkdir(pluginRoot)
    const entry = join(pluginRoot, 'register.ts')
    await writeFile(entry, `export function register(on) { ${handler} }`)
    plugins.push({ name, storageId: `${name}@test`, pluginRoot, entrypoints: [entry] })
  }
  const carried: unknown[] = []
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({ services: { submitPrompt: async input => {
    carried.push(input.callerChain)
    return { text: input.text, origin: input.origin }
  } }, onDiagnostic: event => diagnostics.push(event) })
  cleanups.push(() => runtime.dispose())
  await runtime.reconcile(plugins)
  expect(await runtime.dispatch('ui.press', {}, async () => ({ result: null })))
    .toMatchObject({ result: expect.any(Number) })
  expect(carried).toEqual([[{ plugin: 'p', registration: 1 }, { plugin: 'q', registration: 1 }, { plugin: 'r', registration: 1 }]])
  expect(diagnostics).toEqual([])
})
