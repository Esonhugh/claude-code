import {expect, test} from 'bun:test'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import ts from 'typescript'
import {generateModDeclarationFiles} from './declarations.js'

const canonical = readFileSync(new URL('../../../assets/mods-2.1.292.d.ts.txt', import.meta.url), 'utf8')
const hash = 'ec9fb8b86b52427c134e267749aa04ca84e419735e75810f5d2e5fa23f657ab3'
const author = readFileSync(new URL('./fixtures/author292-contract.ts.txt', import.meta.url), 'utf8')
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

function project(source: string, official = false) {
  const files = Object.fromEntries(generateModDeclarationFiles('2.1.280', [])
    .filter(file => file.path.endsWith('.d.ts')).map(file => ['/virtual/' + file.path, file.text]))
  if (official) files['/virtual/claude-code/index.d.ts'] = canonical
  files['/virtual/author.ts'] = source
  const options: ts.CompilerOptions = {strict: true, noUncheckedIndexedAccess: true, skipLibCheck: false,
    noEmit: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, types: [], lib: ['lib.es2023.d.ts']}
  const host = ts.createCompilerHost(options), read = host.readFile.bind(host), exists = host.fileExists.bind(host)
  const directory = host.directoryExists?.bind(host)
  host.readFile = path => files[path] ?? read(path)
  host.fileExists = path => Object.hasOwn(files, path) || exists(path)
  host.directoryExists = path => Object.keys(files).some(file => file.startsWith(path + '/')) || directory?.(path) === true
  return ts.createProgram(Object.keys(files), options, host)
}
function diagnostics(program: ts.Program) {
  return ts.getPreEmitDiagnostics(program).map(item => ({code: item.code,
    line: item.file?.getLineAndCharacterOfPosition(item.start ?? 0).line,
    message: ts.flattenDiagnosticMessageText(item.messageText, '\n')}))
}
function surface(program: ts.Program) {
  const checker = program.getTypeChecker()
  return checker.getAmbientModules().map(module => ({name: module.name,
    exports: checker.getExportsOfModule(module).map(symbol => symbol.name).sort()}))
}

test('pinned 292 source matches the verified native declaration asset', () => {
  expect(Buffer.byteLength(canonical)).toBe(612117)
  expect(sha(canonical)).toBe(hash)
})

test('generated declarations contain the entire 292 body with the local engine version', () => {
  const text = generateModDeclarationFiles('2.1.280', [])[0]!.text
  expect(text.startsWith('// Written by Claude Code 2.1.280.\n')).toBe(true)
  const start = text.indexOf('// Claude Code function hooks:')
  expect(start).toBeGreaterThanOrEqual(0)
  expect(sha(text.slice(start, start + canonical.length))).toBe(hash)
})

test('all current public names and testing exports match the official checker', () => {
  const local = project(''), official = project('', true)
  expect(diagnostics(official)).toEqual([])
  expect(diagnostics(local)).toEqual([])
  expect(surface(local)).toEqual(surface(official))
  expect(surface(local).find(module => module.name === '"claude-code"')!.exports).toHaveLength(565)
  expect(surface(local).find(module => module.name === '"claude-code/testing"')!.exports).toHaveLength(51)
})

test('strict authors type cache blocks, autocomplete, workflow facts and re-entry guards exactly', () => {
  expect(diagnostics(project(author, true))).toEqual([])
  expect(diagnostics(project(author))).toEqual([])
})

test('invalid latest author inputs produce the same precise diagnostics as official definitions', () => {
  const invalid = `import type {ModelTextBlock, ModelCompleteInput, PromptAutocompleteInput, HookFailure} from 'claude-code';
    const cache:ModelTextBlock={text:'x',cache:false};
    const hook:ModelCompleteInput={model:'sonnet',prompt:[{text:'x'}]};
    const complete:PromptAutocompleteInput={text:'#',cursor:1,start:0};
    const failure:HookFailure={kind:'re-entry',cause:'direct'};`
  const expected = diagnostics(project(invalid, true))
  expect(expected).toHaveLength(4)
  expect(diagnostics(project(invalid))).toEqual(expected)
})
