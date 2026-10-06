import {afterEach, expect, test} from 'bun:test'
import {mkdtemp, mkdir, realpath, rm, writeFile, readFile, symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import ts from 'typescript'
import {ensureModDeclarations} from './declarations.js'
import legacy from './fixtures/legacy289-generated-owned.json'

const roots: string[] = []
afterEach(async () => {await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})))})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'owned-mod-types-migration-')))
  roots.push(root)
  const types = join(root, '.claude-plugin/types')
  for (const [path, text] of Object.entries(legacy)) {
    const file = join(types, path);await mkdir(dirname(file), {recursive: true});await writeFile(file, text)
  }
  return {root, types, stale: join(types, 'claude-code/results.d.ts')}
}

test('an owned legacy result module is retired before authors use the canonical schema', async () => {
  const {root, types, stale} = await fixture()
  expect(await Bun.file(stale).exists()).toBe(true)
  await ensureModDeclarations(root, '2.1.280', [])
  expect(await Bun.file(stale).exists()).toBe(false)
  await mkdir(join(root, 'hooks'))
  await writeFile(join(root, 'hooks/author.ts'), `import type {Register, Color} from 'claude-code';
    const color:Color='diffAdded';export const register:Register=on=>on('session.start',($,e,next)=>next(e));void color;`)
  const configPath = join(types, 'tsconfig.json'), config = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, types, {skipLibCheck: false}, configPath)
  expect([...parsed.errors, ...ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames, parsed.options))].map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n'))).toEqual([])
})

test('an author replacement of the legacy result module is preserved', async () => {
  const {root, stale} = await fixture()
  const author = "declare module 'claude-code' { interface EngineInterface { fixture: { query(): Promise<string> } } }\n"
  await writeFile(stale, author)
  await ensureModDeclarations(root, '2.1.280', [])
  expect(await readFile(stale, 'utf8')).toBe(author)
})

test('a legacy result symlink is preserved without reading or deleting its target', async () => {
  const {root, stale} = await fixture()
  await rm(stale)
  const target = join(root, 'author-contract.d.ts')
  const author = '// author contract\n';await writeFile(target, author);await symlink(target, stale)
  await ensureModDeclarations(root, '2.1.280', [])
  expect(await readFile(target, 'utf8')).toBe(author)
  expect(await Bun.file(stale).exists()).toBe(true)
})
