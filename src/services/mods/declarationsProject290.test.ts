import {afterEach, expect, test} from 'bun:test'
import {mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import ts from 'typescript'
import {ensureModDeclarations} from './declarations.js'

const roots: string[] = []
afterEach(async () => {await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true, force:true})))})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'owned-mod-author-project-')))
  roots.push(root)
  return root
}

test('the default plugin project extends the same native-generated type root as official 290', async () => {
  const root = await fixture()
  await mkdir(join(root, 'hooks'))
  await writeFile(join(root, 'hooks/register.ts'), "import type {Color,Register} from 'claude-code';const color:Color='diffAdded';export const register:Register=on=>on('session.start',($,e,next)=>next(e));void color;\n")
  await ensureModDeclarations(root, '2.1.280', [])
  const configPath = join(root, 'tsconfig.json')
  // Exact bytes observed from the original official 290 plugin loader.
  expect(await readFile(configPath, 'utf8')).toBe('{\n  "extends": "./.claude-plugin/types/tsconfig.json"\n}\n')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, {skipLibCheck:false}, configPath)
  expect([...parsed.errors, ...ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames, parsed.options))].map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([])
  const before = await stat(configPath)
  await ensureModDeclarations(root, '2.1.281', [])
  expect((await stat(configPath)).mtimeMs).toBe(before.mtimeMs)
})

test('a custom root tsconfig remains byte-identical when type roots refresh', async () => {
  const root = await fixture(), file = join(root, 'tsconfig.json'), author = '{"compilerOptions":{"strict":true},"files":[]}\n'
  await writeFile(file, author)
  const before = await stat(file)
  await ensureModDeclarations(root, '2.1.280', [])
  expect(await readFile(file, 'utf8')).toBe(author)
  expect((await stat(file)).mtimeMs).toBe(before.mtimeMs)
})

test('an existing jsconfig prevents creation of a competing default tsconfig', async () => {
  const root = await fixture(), author = '{"checkJs":true}\n'
  await writeFile(join(root, 'jsconfig.json'), author)
  await ensureModDeclarations(root, '2.1.280', [])
  expect(await Bun.file(join(root, 'tsconfig.json')).exists()).toBe(false)
  expect(await readFile(join(root, 'jsconfig.json'), 'utf8')).toBe(author)
  expect(await Bun.file(join(root, '.claude-plugin/types/tsconfig.json')).exists()).toBe(true)
})

test('a root tsconfig symlink and its author target are preserved', async () => {
  const root = await fixture(), target = join(root, 'author-config.json'), author = '{"files":[]}\n'
  await writeFile(target, author)
  await symlink(target, join(root, 'tsconfig.json'))
  await ensureModDeclarations(root, '2.1.280', [])
  expect(await readFile(target, 'utf8')).toBe(author)
})
