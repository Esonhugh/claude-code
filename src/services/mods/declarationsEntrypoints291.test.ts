import {afterEach, expect, test} from 'bun:test'
import {mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import ts from 'typescript'
import {ensureModDeclarations, generateModDeclarationFiles} from './declarations.js'
import {createModsRuntime} from './runtime.js'

const roots: string[] = []
afterEach(async () => {await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true, force:true})))})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'owned-author-entries-')))
  roots.push(root)
  for (const directory of ['hooks', 'code', 'tests']) await mkdir(join(root, directory))
  await writeFile(join(root, 'tests/author.ts'), "import type {Color} from 'claude-code';const color:Color='diffAdded';void color;\n")
  return root
}
async function config(root: string) {
  return JSON.parse(await readFile(join(root, '.claude-plugin/types/tsconfig.json'), 'utf8'))
}
function program(root: string) {
  const path = join(root, 'tsconfig.json'), loaded = ts.readConfigFile(path, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root, {skipLibCheck:false}, path)
  return {parsed, program:ts.createProgram(parsed.fileNames, parsed.options)}
}

test('the exact outside entry is checked without including unrelated sibling files', async () => {
  const root = await fixture(), entry = join(root, 'code/register.ts'), sibling = join(root, 'code/unrelated.ts')
  await writeFile(entry, "const entryCount:number='entry-must-be-checked';export {};\n")
  await writeFile(sibling, "const unrelatedCount:number='sibling-must-stay-out';export {};\n")
  await ensureModDeclarations(root, '2.1.280', [], [entry])
  expect((await config(root)).include).toEqual(['../../hooks', '../../types', '../../tests', '../../code/register.ts'])
  const {parsed, program:checked} = program(root)
  expect(parsed.fileNames).toContain(entry)
  expect(parsed.fileNames).not.toContain(sibling)
  const errors = ts.getPreEmitDiagnostics(checked)
  expect(errors.map(error => ({code:error.code, file:error.file?.fileName}))).toEqual([{code:2322, file:entry}])
})

test('outside entries are deduplicated in order and hooks prefix siblings stay outside', async () => {
  const root = await fixture(), first = join(root, 'code/first.ts'), second = join(root, 'hooks-extra/second.ts')
  await mkdir(join(root, 'hooks-extra'))
  for (const entry of [first, second, join(root, 'hooks/inside.ts')]) await writeFile(entry, 'export {};\n')
  await ensureModDeclarations(root, '2.1.280', [], [first, join(root, 'hooks/inside.ts'), second, first])
  expect((await config(root)).include).toEqual(['../../hooks', '../../types', '../../tests', '../../code/first.ts', '../../hooks-extra/second.ts'])
})

test('refreshing and moving an entry into hooks retires the old include and preserves the author root config', async () => {
  const root = await fixture(), first = join(root, 'code/first.ts'), second = join(root, 'code/second.ts')
  for (const entry of [first, second, join(root, 'hooks/inside.ts')]) await writeFile(entry, 'export {};\n')
  await ensureModDeclarations(root, '2.1.280', [], [first])
  const rootConfig = join(root, 'tsconfig.json'), text = await readFile(rootConfig, 'utf8'), before = await stat(rootConfig)
  expect((await ensureModDeclarations(root, '2.1.280', [], [first])).written).toEqual([])
  await ensureModDeclarations(root, '2.1.280', [], [second])
  expect((await config(root)).include).toEqual(['../../hooks', '../../types', '../../tests', '../../code/second.ts'])
  await ensureModDeclarations(root, '2.1.280', [], [join(root, 'hooks/inside.ts')])
  expect((await config(root)).include).toEqual(['../../hooks', '../../types', '../../tests'])
  expect(await readFile(rootConfig, 'utf8')).toBe(text)
  expect((await stat(rootConfig)).mtimeMs).toBe(before.mtimeMs)
  expect(ts.getPreEmitDiagnostics(program(root).program)).toEqual([])
})

test('an edited generated project is refreshed without requiring restoration', async () => {
  const root = await fixture(), entry = join(root, 'code/register.ts')
  await writeFile(entry, 'export {};\n')
  await ensureModDeclarations(root, '2.1.280', [], [entry])
  const file = join(root, '.claude-plugin/types/tsconfig.json'), owned = await readFile(file, 'utf8')
  const main = join(root, '.claude-plugin/types/claude-code/index.d.ts'), before = await readFile(main, 'utf8')
  const edited = owned + '\n// author customization\n'
  await writeFile(file, edited)
  await ensureModDeclarations(root, '2.1.281', [], [])
  expect(await readFile(file, 'utf8')).not.toBe(edited)
  expect(await readFile(main, 'utf8')).not.toBe(before)
  expect(await readFile(main, 'utf8')).toBe(generateModDeclarationFiles('2.1.281', [])[0]!.text)
  expect((await config(root)).include).toEqual(['../../hooks', '../../types', '../../tests'])
})

test('altered metadata in a generated declaration is replaced with the current project', async () => {
  const root = await fixture(), entry = join(root, 'code/register.ts')
  await writeFile(entry, 'export {};\n')
  await ensureModDeclarations(root, '2.1.280', [], [entry])
  const main = join(root, '.claude-plugin/types/claude-code/index.d.ts')
  const text = await readFile(main, 'utf8')
  expect(text).toMatch(/ tsconfig-sha256=[a-f0-9]{64}\n$/)
  const altered = text.replace(/tsconfig-sha256=[a-f0-9]{64}/, 'tsconfig-sha256=' + '0'.repeat(64))
  await writeFile(main, altered)
  const file = join(root, '.claude-plugin/types/tsconfig.json'), before = await readFile(file, 'utf8')
  await ensureModDeclarations(root, '2.1.281', [], [])
  expect(await readFile(main, 'utf8')).not.toBe(altered)
  expect(await readFile(main, 'utf8')).toBe(generateModDeclarationFiles('2.1.281', [])[0]!.text)
  expect(await readFile(file, 'utf8')).not.toBe(before)
  expect((await config(root)).include).toEqual(['../../hooks', '../../types', '../../tests'])
})

test('a linked plugin root uses the same inside test and an escaping entry is rejected', async () => {
  const root = await fixture(), parent = await realpath(await mkdtemp(join(tmpdir(), 'owned-author-root-link-')))
  roots.push(parent)
  const linked = join(parent, 'plugin')
  await symlink(root, linked)
  await writeFile(join(root, 'hooks/inside.ts'), 'export {};\n')
  await ensureModDeclarations(linked, '2.1.280', [], [join(linked, 'hooks/inside.ts')])
  expect((await config(root)).include).toEqual(['../../hooks', '../../types', '../../tests'])
  await expect(ensureModDeclarations(root, '2.1.280', [], [join(parent, 'escape.ts')])).rejects.toThrow(/entry.*escapes/)
})

test('the runtime passes the admitted entry to the author project and refreshes it on reconcile', async () => {
  const root = await fixture(), outside = join(root, 'code/register.ts'), inside = join(root, 'hooks/register.ts')
  const source = "export function register(on){on('session.start',(_,e,next)=>next(e))}\n"
  await writeFile(outside, source)
  await writeFile(inside, source)
  const diagnostics: unknown[] = [], runtime = createModsRuntime({onDiagnostic:event=>diagnostics.push(event)})
  try {
    await runtime.bind({cwd:root,surface:null,isInteractive:false,sessionId:'owned-author-project'})
    const input = {name:'owned-author-project',storageId:'owned-author-project@inline',pluginRoot:root,entrypoints:[outside]}
    await runtime.reconcile([input])
    expect(diagnostics).toEqual([])
    expect((await config(root)).include).toEqual(['../../hooks', '../../types', '../../tests', '../../code/register.ts'])
    await runtime.reconcile([{...input,entrypoints:[inside]}])
    expect(diagnostics).toEqual([])
    expect((await config(root)).include).toEqual(['../../hooks', '../../types', '../../tests'])
  } finally {await runtime.dispose()}
})
