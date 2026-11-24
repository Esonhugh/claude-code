import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadModDeclaration } from './loader.js'

// Wording of official 2.1.329, measured with `claude plugin validate` on its binary.
const hint = '$ is always spelled $.noun.event(...) at the call site, on is always on("<event>", hook), and next.to always next.to(e, "<tier>")'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function declare(entry: string, source: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mods-scan-refusal-')))
  roots.push(root)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, entry), source)
  return { root, declaration: loadModDeclaration({ pluginRoot: root, name: 'probe', storageId: 'probe@inline', entrypoints: [join(root, entry)] }) }
}
// The statement under test is on line 3.
const startHook = (statement: string) => `export function register(on) {
  on('session.start', async ($, e, next) => {
    ${statement}
    return next(e)
  })
}
`
const engineHook = (statement: string) => `export function register(on) {
  on('engine.create', async ($, e, next) => {
    ${statement}
  })
}
`

test.each([
  ['const c = $.clock', '$.clock is used as a value (a noun of $ bound, passed or read)'],
  ['String($.store)', '$.store is used as a value (a noun of $ bound, passed or read)'],
  ['const o = { ...$.ui }', '$.ui is used as a value (a noun of $ bound, passed or read)'],
  ['$.clock?.now()', '$.clock is used as a value (a noun of $ bound, passed or read)'],
  ["$.clock['now']()", '$.clock is used as a value (a noun of $ bound, passed or read)'],
  ['const now = $.clock.now', '$.clock.now is used as a value (an event of $ bound, passed or read) instead of called'],
  ['typeof $.clock.now', '$.clock.now is used as a value (an event of $ bound, passed or read) instead of called'],
  ['$.clock.now?.()', '$.clock.now is used as a value (an event of $ bound, passed or read) instead of called'],
  ['const p = $.plugin', '$.plugin is used other than as $.plugin.name or $.plugin.root'],
  ['const { name } = $.plugin', '$.plugin is used other than as $.plugin.name or $.plugin.root'],
  ["$['clock'].now()", 'a computed or optional member access on $'],
])('refuses %s and names the plugin, the file as written and its line', async (statement, construct) => {
  const { root, declaration } = await declare('main.mjs', startHook(statement))
  await expect(declaration).rejects.toThrow(`probe: ${join(root, 'main.mjs')}:3: ${construct}; ${hint}`)
})

test.each([
  'await $.clock.now()',
  'const name = $.plugin.name + $.plugin.root',
  'const at = (await $.clock.now()).toString()',
])('admits %s', async statement => {
  const { declaration } = await declare('main.mjs', startHook(statement))
  expect((await declaration).events).toEqual(['session.start'])
})

test.each([
  ['const below = await next(e)\n    return { ...below, clock: below.clock }', 4, '$.clock is used as a value (a noun of $ bound, passed or read)'],
  ['const { clock, ...beneath } = await next(e)\n    clock.now()\n    return { ...beneath }', 4, '"clock", destructured from $ at engine.create, is read (a noun bound to a name); leave it unread or call it as $.noun.event(...)'],
  ['const below = await next(e)\n    const { clock } = below\n    clock.now()\n    return below', 5, '"clock", destructured from $ at engine.create, is read (a noun bound to a name); leave it unread or call it as $.noun.event(...)'],
  ['let below = await next(e)\n    return below', 3, 'the value of next(e) at engine.create is bound with let or var (const only)'],
])('refuses an engine.create hook that reads a noun of next(e): %s', async (statement, line, construct) => {
  const { root, declaration } = await declare('main.mjs', engineHook(statement))
  await expect(declaration).rejects.toThrow(`probe: ${join(root, 'main.mjs')}:${line}: ${construct}; ${hint}`)
})

test.each([
  'const below = await next(e)\n    await below.clock.now()\n    return below',
  'const { ui, fs, ...beneath } = await next(e)\n    await beneath.clock.now()\n    return { ...beneath }',
])('admits the engine.create forms that call through or withhold: %s', async statement => {
  const { declaration } = await declare('main.mjs', engineHook(statement))
  expect((await declaration).calls).toEqual(['clock.now'])
})

test('names a compiled line of a TypeScript module with the line, cut at 80 characters', async () => {
  const { root, declaration } = await declare('main.ts', startHook(`const c: unknown[] = [$.clock, 'a long string that runs the compiled line past eighty characters']`))
  await expect(declaration).rejects.toThrow(`probe: ${join(root, 'main.ts')}, compiled line 3 \`const c = [$.clock, "a long string that runs the compiled line past eighty chara...\`: $.clock is used as a value (a noun of $ bound, passed or read); ${hint}`)
})

test('names where a JavaScript module stops parsing', async () => {
  const { root, declaration } = await declare('main.mjs', startHook('const = 1'))
  await expect(declaration).rejects.toThrow(new Error(`probe: ${join(root, 'main.mjs')} does not parse: Unexpected token (3:10)`))
})
