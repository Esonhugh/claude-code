import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadModDeclaration } from './loader.js'

const head = [0, 97, 115, 109, 1, 0, 0, 0]
// (func (export "answer") (result i32) i32.const 42)
const answer = (value = 42) => Uint8Array.from([...head, 1, 5, 1, 0x60, 0, 1, 0x7f, 3, 2, 1, 0,
  7, 10, 1, 6, 97, 110, 115, 119, 101, 114, 0, 0, 10, 6, 1, 4, 0, 0x41, value, 0x0b])

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(files: Record<string, string | Uint8Array>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mods-wasm-scan-')))
  roots.push(root)
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true })
    await writeFile(join(root, name), content)
  }
  return root
}
const declare = (root: string, entry = 'entry.mjs', name = 'probe') =>
  loadModDeclaration({ pluginRoot: root, name, storageId: `${name}@inline`, entrypoints: [join(root, entry)] })
const hook = (body: string) => `export function register(on){on('tool.call', async $ => { ${body} })}`

test('a literal path is listed as a plugin-relative file with its spelling', async () => {
  const root = await fixture({
    'lib/entry.mjs': hook(`const m = await $.wasm.compile('./engine.wasm'); return {result:1}`),
    'lib/engine.wasm': answer(),
  })
  const declaration = await declare(root, 'lib/entry.mjs')
  expect(declaration.calls).toContain('wasm.compile')
  expect(declaration.wasm).toEqual({ files: [{ path: 'lib/engine.wasm', spellings: ['./engine.wasm'] }] })
})

test('a saved binary changes the declaration by its content alone', async () => {
  const root = await fixture({ 'entry.mjs': hook(`await $.wasm.compile('./engine.wasm'); return {result:1}`) })
  const missing = (await declare(root)).fingerprint
  await writeFile(join(root, 'engine.wasm'), answer())
  const saved = (await declare(root)).fingerprint
  await writeFile(join(root, 'engine.wasm'), answer())
  expect((await declare(root)).fingerprint).toBe(saved)
  await writeFile(join(root, 'engine.wasm'), answer(7))
  expect(new Set([missing, saved, (await declare(root)).fingerprint]).size).toBe(3)
})

test('bytes made at run time are marked, string expressions refused', async () => {
  const root = await fixture({ 'entry.mjs': hook(`await $.wasm.compile(new Uint8Array(8)); return {result:1}`) })
  expect((await declare(root)).wasm).toEqual({ files: [], isMadeAtRunTime: true })
  // A name bound to another name is not followed; a template with no substitution is a literal.
  await writeFile(join(root, 'entry.mjs'), `const bytes = new Uint8Array(8); const alias = bytes;
    ${hook('await $.wasm.compile(alias); await $.wasm.compile(`./a.wasm`); return {result:1}')}`)
  expect((await declare(root)).wasm).toEqual({ files: [{ path: 'a.wasm', spellings: ['./a.wasm'] }], isMadeAtRunTime: true })
  for (const argument of ['`./${"a"}.wasm`', '"./a" + ".wasm"', 'Math.random() ? "./a.wasm" : bytes', '', '...parts', 'name', '42']) {
    await writeFile(join(root, 'entry.mjs'), `const name = './' + 'a.wasm'; const bytes = new Uint8Array(8); const parts = [];
      ${hook(`await $.wasm.compile(${argument}); return {result:1}`)}`)
    await expect(declare(root)).rejects.toThrow("$.wasm.compile takes a string literal naming a .wasm file of the plugin's own, so the files a module compiles can be listed, or bytes")
  }
})

test('a literal path is relative, names a .wasm file and stays in the plugin', async () => {
  const root = await fixture({ 'entry.mjs': '' })
  for (const [spelling, reason] of [
    ['engine.wasm', 'is not relative: spell it from this file ("./engine.wasm")'],
    ['/tmp/engine.wasm', 'is not relative: spell it from this file ("./engine.wasm")'],
    ['./engine.bin', 'does not end in .wasm'],
    ['../engine.wasm', "leaves the plugin's folder"],
  ]) {
    await writeFile(join(root, 'entry.mjs'), hook(`await $.wasm.compile(${JSON.stringify(spelling)}); return {result:1}`))
    await expect(declare(root)).rejects.toThrow(`$.wasm.compile's path "${spelling}" ${reason}`)
  }
})
