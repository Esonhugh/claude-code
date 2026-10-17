import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadModDeclaration } from './loader.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})
async function load(source: string, helper?: string) {
  const root = await mkdtemp(join(tmpdir(), 'mod-named-handler-'))
  roots.push(root)
  const entry = join(root, 'register.ts')
  await writeFile(entry, source)
  if (helper) await writeFile(join(root, 'helper.ts'), helper)
  return loadModDeclaration({
    name: 'named',
    storageId: 'named@test',
    pluginRoot: root,
    entrypoints: [entry],
  })
}
test('scans top-level named and imported handlers with the correct engine and continuation roles', async () => {
  const local = await load(
    `function draw($,e,next){$.ui.log('named');return next(e)} export function register(on){on('ui.render',{component:'Pane'},draw)}`,
  )
  expect(local.events).toEqual(['ui.render'])
  expect(local.calls).toContain('ui.log')
  const imported = await load(
    `import {draw as handler} from './helper.ts';export function register(on){on('ui.render',{component:'Pane'},handler)}`,
    `export function draw($,e,next){$.ui.status('imported');return next(e)}`,
  )
  expect(imported.calls).toContain('ui.status')
})
test('rejects nested and dynamic named handlers and validates named generator contracts', async () => {
  await expect(
    load(
      `export function register(on){function draw($,e,next){return next(e)}on('ui.render',draw)}`,
    ),
  ).rejects.toThrow('top of its file')
  await expect(
    load(
      `let draw=($,e,next)=>next(e);export function register(on){on('ui.render',draw)}`,
    ),
  ).rejects.toThrow('top of its file')
  await expect(
    load(
      `function step($,e,next){return next(e)}export function register(on){on('turn.step',step)}`,
    ),
  ).rejects.toThrow('async generators')
})
