import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime, type ModPluginInput } from './runtime.js'

// Official 2.1.329 session.start: "A later one runs its hooks alone: an enable, a worker respawn,
// or a reload (changed modules only; all if one hooks `engine.create`/`plugin.register`)."
// Measured against the 2.1.329 binary: only a changed module's hooks count, in its old or its new version.
let root: string
const runtimes: ReturnType<typeof createModsRuntime>[] = []
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'mods-reload-escalation-'))) })
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
  await rm(root, { recursive: true, force: true })
})

async function plugin(name: string, extra = ''): Promise<ModPluginInput> {
  const pluginRoot = join(root, name)
  await mkdir(pluginRoot, { recursive: true })
  const entry = join(pluginRoot, 'register.mjs')
  // `load` changes each time the module is evaluated; `started` counts session.start of this load.
  await writeFile(entry, `const load = Math.random(); let started = 0
    export function register(on) {
      ${extra}
      on('session.start', ($, e, next) => { started++; return next(e) })
      on('tool.call', async ($, e, next) => {
        const below = await next(e)
        return { result: { ...below.result, ${JSON.stringify(name)}: { load, started } } }
      })
    }`)
  return { name, storageId: `${name}@test`, pluginRoot, entrypoints: [entry] }
}

async function loads(runtime: ReturnType<typeof createModsRuntime>) {
  const answer = await runtime.dispatch('tool.call', {}, async () => ({ result: {} })) as { result: Record<string, { load: number; started: number }> }
  return answer.result
}

async function start(inputs: ModPluginInput[]) {
  const runtime = createModsRuntime({})
  runtimes.push(runtime)
  await runtime.bind({ cwd: root, surface: 'terminal', isInteractive: false, sessionId: 'reload-escalation' })
  await runtime.reconcile(inputs)
  return runtime
}

const ENGINE_CREATE = "on('engine.create', ($, e, next) => next(e))"
const PLUGIN_REGISTER = "on('plugin.register', ($, e, next) => next(e))"

test.each([
  ['hooks engine.create', ENGINE_CREATE, ENGINE_CREATE],
  ['hooks plugin.register', PLUGIN_REGISTER, PLUGIN_REGISTER],
  ['starts hooking engine.create', '', ENGINE_CREATE],
  ['stops hooking engine.create', ENGINE_CREATE, ''],
])('a reload escalates to every module when the changed one %s', async (_, oldExtra, newExtra) => {
  const changed = await plugin('changed', oldExtra)
  const unchanged = await plugin('unchanged')
  const runtime = await start([changed, unchanged])
  const before = await loads(runtime)
  expect(before.unchanged!.started).toBe(1)
  await plugin('changed', newExtra)
  await runtime.reconcile([changed, unchanged], new Set([changed.storageId]))
  const after = await loads(runtime)
  expect(after.changed!.load).not.toBe(before.changed!.load)
  expect(after.unchanged!.load).not.toBe(before.unchanged!.load)
  expect(after.unchanged!.started).toBe(1)
})

test.each([
  ['engine.create', ENGINE_CREATE],
  ['plugin.register', PLUGIN_REGISTER],
])('an unchanged module hooking %s does not escalate a reload', async (_, unchangedExtra) => {
  const changed = await plugin('changed')
  const unchanged = await plugin('unchanged', unchangedExtra)
  const runtime = await start([changed, unchanged])
  const before = await loads(runtime)
  await runtime.reconcile([changed, unchanged], new Set([changed.storageId]))
  const after = await loads(runtime)
  expect(after.changed!.load).not.toBe(before.changed!.load)
  expect(after.unchanged).toEqual(before.unchanged)
})

test('without engine.create or plugin.register a reload keeps unchanged modules loaded', async () => {
  const changed = await plugin('changed')
  const unchanged = await plugin('unchanged')
  const runtime = await start([changed, unchanged])
  const before = await loads(runtime)
  await runtime.reconcile([changed, unchanged], new Set([changed.storageId]))
  const after = await loads(runtime)
  expect(after.changed!.load).not.toBe(before.changed!.load)
  expect(after.unchanged).toEqual(before.unchanged)
})

test('enabling a new module does not reload the loaded ones, even when one hooks engine.create', async () => {
  const first = await plugin('first', "on('engine.create', ($, e, next) => next(e))")
  const runtime = await start([first])
  const before = await loads(runtime)
  await runtime.reconcile([first, await plugin('added')])
  const after = await loads(runtime)
  expect(after.first).toEqual(before.first)
  expect(after.added!.started).toBe(1)
})
