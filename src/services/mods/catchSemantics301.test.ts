import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime } from './runtime.js'

let root: string
let runtime: ReturnType<typeof createModsRuntime> | undefined
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'mods-catch-301-'))) })
afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
  await rm(root, { recursive: true, force: true })
})

// 2.1.301: a hook's .catch runs only when the hook throws or times out; events
// raised beneath the hook's own calls skip that hook without asking its .catch.
test('.catch runs only for the hook failing, never for events beneath its own calls', async () => {
  await writeFile(join(root, 'a.txt'), 'A')
  await writeFile(join(root, 'b.txt'), 'B')
  const entry = join(root, 'register.mjs')
  await writeFile(entry, `let runs = 0, caught = [];
  export function register(on) {
    on('fs.read', async ($, e, next) => {
      runs++;
      if (e.path.endsWith('boom.txt')) throw new Error('boom');
      const inner = await $.fs.read('b.txt');
      return {value: (await next(e)).value + inner};
    }).catch(($, e, next) => { caught.push(next.error.kind + ':' + next.error.message); return {value: 'caught'} });
    on('tool.call', async ($, e) => {
      if (e.input === 'report') return {result: {runs, caught}};
      return {result: await $.fs.read(e.input)};
    });
  }`)
  runtime = createModsRuntime()
  await runtime.bind({ cwd: root, surface: 'terminal', isInteractive: true, sessionId: 'catch-301' })
  await runtime.reconcile([{ name: 'guard', storageId: 'guard@fixture', pluginRoot: root, entrypoints: [entry] }])
  const call = async (input: string) =>
    ((await runtime!.dispatch('tool.call', { input }, async () => ({ result: 'core' }))) as { result: unknown }).result
  expect(await call('a.txt')).toBe('AB')
  expect(await call('boom.txt')).toBe('caught')
  expect(await call('report')).toEqual({ runs: 2, caught: ['throw:boom'] })
})
