import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime, type ModDiagnostic } from './runtime.js'

let root: string
const runtimes: ReturnType<typeof createModsRuntime>[] = []
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'mods-edit-runtime-')) })
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
  await rm(root, {recursive: true, force: true})
})
const input = () => ({origin: {kind: 'composer'}, key: {key: 'X'}, text: 'a😀b', cursor: 3, start: 3, end: 3, inputText: 'X'})
async function setup(body: string) {
  const folder = join(root, 'plugin'); await mkdir(folder)
  const entry = join(folder, 'register.ts'); await writeFile(entry, `export function register(on) { ${body} }`)
  const diagnostics: ModDiagnostic[] = []
  const runtime = createModsRuntime({onDiagnostic: event => diagnostics.push(event)})
  runtimes.push(runtime)
  await runtime.reconcile([{name: 'edit-probe', storageId: 'edit-probe@test', pluginRoot: folder, entrypoints: [entry]}])
  expect(diagnostics).toEqual([])
  const snapshot = runtime.capture()
  expect(snapshot.hasHooks('prompt.edit')).toBe(true)
  snapshot.release()
  return {runtime, diagnostics}
}

test('actual author Worker prompt.edit consumes an edit and sees the 50ms budget', async () => {
  const {runtime, diagnostics} = await setup(`on('prompt.edit', ($, e, next) => ({text: e.text + ':' + next.budget.ms, cursor: e.cursor}));`)
  expect(await runtime.dispatch('prompt.edit', input(), async () => ({text: 'core entered', cursor: 0})))
    .toEqual({text: 'a😀b:50', cursor: 3})
  expect(diagnostics).toEqual([])
})

test.each([
  `{ ...e, origin: {kind: 'plugin', name: 'fake'} }`,
  `{ ...e, key: {key: 'Q'} }`,
  `{ ...e, start: 2.5 }`,
  `{ ...e, end: 99 }`,
])('actual author Worker rejects pinned or malformed next input %s and restores the person edit', async rewrite => {
  const {runtime, diagnostics} = await setup(`on('prompt.edit', ($, e, next) => next(${rewrite}));`)
  const seen: unknown[] = []
  expect(await runtime.dispatch('prompt.edit', input(), async e => {seen.push(e); return {text: 'a😀Xb', cursor: 4}}))
    .toEqual({text: 'a😀Xb', cursor: 4})
  expect(seen).toEqual([input()])
  expect(diagnostics).toHaveLength(1)
  expect(diagnostics[0]!.stage).toBe('prompt.edit')
})

test('actual author Worker validates result cursor and decoration styles before displaying them', async () => {
  const {runtime, diagnostics} = await setup(`on('prompt.edit', () => ({text:'bad',cursor:1,decorations:[{start:0,end:1,unknown:true}]}));`)
  expect(await runtime.dispatch('prompt.edit', input(), async () => ({text: 'a😀Xb', cursor: 4})))
    .toEqual({text: 'a😀Xb', cursor: 4})
  expect(diagnostics).toHaveLength(1)
})

test('actual author Worker synchronous CPU timeout must retire cleanly after prompt.edit 50ms fallback', async () => {
  const {runtime, diagnostics} = await setup(`on('prompt.edit', () => {for (;;) {}});`)
  const started = performance.now()
  expect(await runtime.dispatch('prompt.edit', input(), async () => ({text: 'a😀Xb', cursor: 4})))
    .toEqual({text: 'a😀Xb', cursor: 4})
  expect(performance.now() - started).toBeLessThan(500)
  expect(diagnostics).toHaveLength(1)
})


test('actual author Worker yielding timeout uses 50ms and leaves disposal responsive', async () => {
  const {runtime, diagnostics} = await setup(`on('prompt.edit', async $ => {await $.clock.sleep(1000); return {text:'too late',cursor:0}});`)
  const started = performance.now()
  expect(await runtime.dispatch('prompt.edit', input(), async () => ({text: 'a😀Xb', cursor: 4})))
    .toEqual({text: 'a😀Xb', cursor: 4})
  expect(performance.now() - started).toBeLessThan(500)
  expect(diagnostics).toHaveLength(1)
})
