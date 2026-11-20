import {expect, test} from 'bun:test'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import ts from 'typescript'

const baseline = readFileSync(new URL('../../../assets/mods-2.1.329.d.ts.txt', import.meta.url), 'utf8')

test('the 329 author baseline matches the declaration extracted from the official platform package', () => {
  expect(Buffer.byteLength(baseline)).toBe(863400)
  expect(createHash('sha256').update(baseline).digest('hex')).toBe('2844f0e5e0886272ad3736e5282d3c4a9f7a9296d0d7ccb823451aa9dbe7365b')
})

test('the 329 author can type public events, host calls and shader imports without internal API leakage', () => {
  const options: ts.CompilerOptions = {
    strict: true, noUncheckedIndexedAccess: true, noEmit: true, types: [], lib: ['lib.es2023.d.ts'],
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  }
  const host = ts.createCompilerHost(options)
  const read = host.readFile.bind(host)
  const files: Record<string, string> = {
    '/claude-code.d.ts': baseline,
    '/author.ts': readFileSync(new URL('./fixtures/author329-contract.ts.txt', import.meta.url), 'utf8'),
  }
  host.readFile = path => files[path] ?? read(path)
  const program = ts.createProgram(Object.keys(files), options, host)
  expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([])
}, 30_000)
