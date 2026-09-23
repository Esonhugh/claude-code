import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createModsRuntime } from './runtime.js'

let root: string
const runtimes: ReturnType<typeof createModsRuntime>[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mods-model-runtime-'))
})

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
  await rm(root, { recursive: true, force: true })
})

async function plugin(name: string, source: string) {
  const pluginRoot = join(root, name)
  await mkdir(pluginRoot)
  const entry = join(pluginRoot, 'register.ts')
  await writeFile(entry, source)
  return {
    name,
    storageId: `${name}@test`,
    pluginRoot,
    entrypoints: [entry],
  }
}

const binding = (cwd: string) => ({
  cwd,
  sessionId: 'test',
  surface: 'terminal' as const,
  isInteractive: true,
})

test('model operations cross loader, Worker and hookable runtime into the completion boundary', async () => {
  const consumer = await plugin('consumer', `export function register(on) {
    on('*', async ($, e, next) => {
      if (next.event !== 'tool.call') return next(e);
      const before = next.budget.remainingMs;
      const complete = await $.model.complete({model:'haiku',prompt:'direct'});
      const classify = await $.model.classify('classify me',['bug','feature']);
      return {result:{complete,classify,budgetSpent:before-next.budget.remainingMs}};
    });
  }`)
  const policy = await plugin('policy', `export function register(on) {
    on('model.classify', ($, e, next) => next({...e,text:e.text+' as data'}));
    on('model.complete', ($, e, next) => {
      if(next.origin.plugin!=='consumer') return {deny:'bad origin'};
      if(e.prompt.includes('classify me')) return {value:'bug'};
      return next({...e,prompt:e.prompt+' rewritten'});
    });
  }`)
  const sibling = await plugin('consumer-observer', `export function register(on) {
    on('model.complete', ($, e, next) => e.prompt.includes('classify me')
      ? next({...e,prompt:e.prompt+' sibling'})
      : next(e));
  }`)
  const requests: unknown[] = []
  const value = createModsRuntime({ services: {
    modelComplete: async (request, signal) => {
      requests.push({ request, signal })
      await delay(80, undefined, { signal })
      return `reply:${request.prompt}`
    },
  } })
  runtimes.push(value)
  await value.bind(binding(root))
  await value.reconcile([consumer, policy, sibling])

  const result = await value.dispatch('tool.call', {}, async () => ({ result: 'core' }))
  expect(result).toEqual({ result: {
    complete: 'reply:direct rewritten',
    classify: 'bug',
    budgetSpent: expect.any(Number),
  } })
  expect((result as {result:{budgetSpent:number}}).result.budgetSpent).toBeLessThan(60)
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({
    request: { model: 'haiku', prompt: 'direct rewritten' },
  })
})

test('model operations reject deny envelopes without reaching completion', async () => {
  const consumer = await plugin('consumer-deny', `export function register(on) {
    on('tool.call', async ($) => {
      try { await $.model.complete({model:'haiku',prompt:'blocked'}); return {result:'unexpected'}; }
      catch(error) { return {result:error.message}; }
    });
  }`)
  const policy = await plugin('policy-deny', `export function register(on) {
    on('model.complete', () => ({deny:'completion denied'}));
  }`)
  let completions = 0
  const diagnostics: unknown[] = []
  const value = createModsRuntime({
    onDiagnostic: event => diagnostics.push(event),
    services: { modelComplete: async () => { completions++; return 'unused' } },
  })
  runtimes.push(value)
  await value.bind(binding(root))
  await value.reconcile([policy, consumer])

  const denied = await value.dispatch('tool.call', {}, async () => ({ result: 'core' }))
  expect(denied).toEqual({result:'completion denied'})
  expect(diagnostics).toEqual([])
  expect(completions).toBe(0)
})

test('a reloaded caller uses the new Worker while an in-flight model request drains with its abort signal', async () => {
  const source = (prompt: string) => `export function register(on) {
    on('tool.call', async ($) => ({result:await $.model.complete({model:'haiku',prompt:'${prompt} '})}));
  }`
  const consumer = await plugin('reload-model', source('old'))
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const signals: AbortSignal[] = []
  let calls = 0
  const value = createModsRuntime({ services: {
    modelComplete: async (request, signal) => {
      calls++
      signals.push(signal!)
      if (request.prompt.startsWith('old')) {
        started.resolve()
        await release.promise
      }
      return request.prompt.trim()
    },
  } })
  runtimes.push(value)
  await value.bind(binding(root))
  await value.reconcile([consumer])

  const pending = value.dispatch('tool.call', {}, async () => ({ result: 'core' }))
  await started.promise
  await writeFile(consumer.entrypoints[0]!, source('new'))
  await value.reconcile([consumer])
  expect(await value.dispatch('tool.call', {}, async () => ({ result: 'core' })))
    .toEqual({result:'new'})
  expect(signals[0]!.aborted).toBe(false)
  release.resolve()
  expect(await pending).toEqual({result:'old'})
  expect(calls).toBe(2)
})

test('aborting the parent request rejects the model operation and aborts the completion boundary', async () => {
  const consumer = await plugin('abort-model', `export function register(on) {
    on('tool.call', async ($) => ({result:await $.model.complete({model:'haiku',prompt:'wait'})}));
  }`)
  const entered = Promise.withResolvers<void>()
  let boundarySignal: AbortSignal | undefined
  const value = createModsRuntime({ services: {
    modelComplete: async (_request, signal) => {
      boundarySignal = signal
      entered.resolve()
      await delay(10_000, undefined, { signal })
      return 'unexpected'
    },
  } })
  runtimes.push(value)
  await value.bind(binding(root))
  await value.reconcile([consumer])
  const controller = new AbortController()
  const pending = value.dispatch('tool.call', {}, async () => ({ result: 'core' }), {
    signal: controller.signal,
  })
  await entered.promise
  controller.abort(new Error('cancel model request'))

  await expect(pending).rejects.toMatchObject({name:'AbortError'})
  expect(boundarySignal?.aborted).toBe(true)
})