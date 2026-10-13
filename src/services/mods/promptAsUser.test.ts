import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime } from './runtime.js'

let root: string
const runtimes: ReturnType<typeof createModsRuntime>[] = []
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'mods-as-user-')) })
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
  await rm(root, { recursive: true, force: true })
})
async function plugin(source: string) {
  const pluginRoot = join(root, 'caller')
  await mkdir(pluginRoot)
  const entry = join(pluginRoot, 'register.ts')
  await writeFile(entry, source)
  return { name: 'prompt-caller', storageId: 'prompt-caller@test', pluginRoot, entrypoints: [entry] }
}

test.each([undefined, false, true])('public submit with asUser=%s preserves plugin provenance through the actual Worker', async asUser => {
  const declaration = await plugin(`export function register(on) {
    on('ui.press',async($,e)=>{
      try{return {result:await $.prompt.submit(e.input)}}catch(error){return {result:{error:error.message}}}
    });
  }`)
  const entries: unknown[] = []
  const runtime = createModsRuntime({ services: { submitPrompt: async input => {
    entries.push({ text: input.text, origin: input.origin, aborted: input.signal.aborted })
    return { text: input.text, origin: input.origin }
  } } })
  runtimes.push(runtime)
  await runtime.reconcile([declaration])
  const input = { text: 'typed through a plugin', ...(asUser === undefined ? {} : { asUser }) }
  const origin = { kind: 'plugin', name: 'prompt-caller', ...(asUser === true ? { asUser: true } : {}) }
  expect(await runtime.dispatch('ui.press', { input }, async () => ({ result: null }))).toEqual({ result: { text: input.text, origin } })
  expect(entries).toEqual([{ text: input.text, origin, aborted: false }])
})

test('invalid asUser values never enter the submission host', async () => {
  const declaration = await plugin(`export function register(on) {
    on('ui.press',async($,e)=>{try{await $.prompt.submit(e.input)}catch(error){return {result:error.message}}});
  }`)
  let entries = 0
  const runtime = createModsRuntime({ services: { submitPrompt: async input => {
    entries++; return { text: input.text, origin: input.origin }
  } } })
  runtimes.push(runtime)
  await runtime.reconcile([declaration])
  for (const asUser of [null, 0, 1, 'true', {}]) {
    const result = await runtime.dispatch('ui.press', { input: { text: 'invalid', asUser } }, async () => ({ result: null }))
    expect(result).toMatchObject({ result: expect.stringContaining('asUser') })
  }
  expect(entries).toBe(0)
})

test('public submit ignores extra fields while deriving origin from the caller', async () => {
  const declaration = await plugin(`export function register(on) {
    on('ui.press', async ($,e)=>{
      try{return {result:await $.prompt.submit(e.input)}}catch(error){return {result:{error:error.message}}}
    });
  }`)
  const entries: unknown[] = []
  const runtime = createModsRuntime({ services: { submitPrompt: async input => {
    entries.push({ ...input, signal: input.signal instanceof AbortSignal })
    return { text: input.text, origin: input.origin }
  } } })
  runtimes.push(runtime)
  await runtime.reconcile([declaration])
  const input = {
    text: ' raw text ', asUser: true, origin: { kind: 'composer' }, wait: true,
    turnId: 'forged-turn', context: ['forged-context'], attachments: [{ type: 'binary', data: 'not-forwarded' }],
  }
  const origin = { kind: 'plugin', name: 'prompt-caller', asUser: true }
  expect(await runtime.dispatch('ui.press', { input }, async () => ({ result: null })))
    .toEqual({ result: { text: input.text, origin } })
  expect(entries).toEqual([{ text: input.text, origin, signal: true, callerChain: [{ plugin: 'prompt-caller', registration: 1 }] }])
})

test('a tool hook cannot hold its own turn while waiting for a later prompt', async () => {
  const declaration = await plugin(`export function register(on) {
    on('tool.call', async $=>{try{await $.prompt.submit({text:'would deadlock'})}catch(error){return {result:error.message}}});
  }`)
  let entries = 0
  const runtime = createModsRuntime({ services: { submitPrompt: async input => {
    entries++; return { text: input.text, origin: input.origin }
  } } })
  runtimes.push(runtime)
  await runtime.reconcile([declaration])
  expect(await runtime.dispatch('tool.call', {}, async () => ({ result: null })))
    .toMatchObject({ result: expect.stringContaining('turn') })
  expect(entries).toBe(0)
})

test('public submit ignores extra positional arguments', async () => {
  const declaration = await plugin(`export function register(on) {
    on('ui.press',async $=>({result:await $.prompt.submit({text:'first'}, {text:'ignored'})}));
  }`)
  const entries: unknown[] = []
  const runtime = createModsRuntime({ services: { submitPrompt: async input => {
    entries.push(input.text); return { text: input.text, origin: input.origin }
  } } })
  runtimes.push(runtime)
  await runtime.reconcile([declaration])
  expect(await runtime.dispatch('ui.press', {}, async () => ({result:null})))
    .toEqual({result:{text:'first',origin:{kind:'plugin',name:'prompt-caller'}}})
  expect(entries).toEqual(['first'])
})
