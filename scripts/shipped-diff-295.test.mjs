import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { URL } from 'node:url'
import { TextDecoder } from 'node:util'
import { unzipSync } from 'fflate'
import { packageOfficialDiff } from './package-official-diff.mjs'
import { getVerifiedOfficialShippedModDeclaration, loadOfficialShippedDiffDefinition } from '../src/plugins/builtinShippedMods.ts'

const roots = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function original295() {
  const root = await mkdtemp(join(tmpdir(), 'diff-original295-')); roots.push(root)
  const archive = await readFile(new URL('../assets/builtin-diff-2.1.295.zip', import.meta.url))
  const entries = unzipSync(archive)
  for (const name of ['chunk-8mmnqsff.js', 'chunk-56g3eekf.js'])
    await writeFile(join(root, name), entries['official/' + name])
  return { root, archive }
}
test('offline producer packages the actual official295 module and identity without changing author source', async () => {
  const { root, archive } = await original295(), output = join(root, 'out.zip')
  await packageOfficialDiff({ modulesDir: root, output })
  expect(await readFile(output)).toEqual(archive)
})
test('production loader accepts genuine official295 and emits its actual register closure', async () => {
  const { root, archive } = await original295()
  const definition = await loadOfficialShippedDiffDefinition(join(root, 'chunk-8mmnqsff.js'), join(root, 'plugin'))
  expect(definition.version).toBe('2.1.295')
  expect(definition.name).toBe('cc-plugin-diff')
  const files = unzipSync(archive)
  expect(definition.hookModules[0].paths).toEqual(['./register.js'])
  expect(new TextDecoder().decode(files['cc-plugin-diff/hooks/register.js'])).toEndWith('export {xm as register};\n')
  expect(getVerifiedOfficialShippedModDeclaration(definition).modules[0].source)
    .toBe(new TextDecoder().decode(files['cc-plugin-diff/hooks/register.js']))
})
