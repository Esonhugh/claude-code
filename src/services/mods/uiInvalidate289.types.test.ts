import {expect, test} from 'bun:test'
import ts from 'typescript'
import {generateModDeclarationFiles} from './declarations.js'

function diagnostics(author: string): readonly string[] {
  const files = Object.fromEntries(generateModDeclarationFiles('0.0.0-invalidate-test')
    .filter(file => file.path.endsWith('.d.ts'))
    .map(file => [`/virtual/${file.path}`, file.text]))
  files['/virtual/author.ts'] = author
  const options: ts.CompilerOptions = {
    strict: true, noUncheckedIndexedAccess: true, skipLibCheck: false, noEmit: true,
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, types: [], lib: ['lib.es2023.d.ts'],
  }
  const host = ts.createCompilerHost(options)
  const read = host.readFile.bind(host)
  const exists = host.fileExists.bind(host)
  const directoryExists = host.directoryExists?.bind(host)
  host.directoryExists = directory => Object.keys(files).some(file => file.startsWith(`${directory}/`)) || directoryExists?.(directory) === true
  host.readFile = path => files[path] ?? read(path)
  host.fileExists = path => Object.hasOwn(files, path) || exists(path)
  return ts.getPreEmitDiagnostics(ts.createProgram(Object.keys(files), options, host))
    .map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n'))
}

test('generated author invalidate returns void and cannot be consumed as a Promise or value', () => {
  expect(diagnostics(`import type {EngineInterface} from 'claude-code';
    declare const $:EngineInterface;
    type Equal<A,B>=(<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;
    type Assert<T extends true>=T;
    type Returned=Assert<Equal<ReturnType<typeof $.ui.invalidate>,void>>;
    const returned:void=$.ui.invalidate('ui.render');
    // @ts-expect-error Invalidation is a synchronous scheduling sugar.
    const promise:Promise<void>=$.ui.invalidate('ui.render');
    // @ts-expect-error Its return value does not contain an operation receipt.
    const receipt:{value:undefined}=$.ui.invalidate('ui.render');
    void [returned,promise,receipt]; export type {Returned};
  `)).toEqual([])
})

test('generated InvalidatableEventName preserves the official seven-event boundary', () => {
  expect(diagnostics(`import type {EngineInterface,InvalidatableEventName} from 'claude-code';
    declare const $:EngineInterface;
    type Equal<A,B>=(<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;
    type Assert<T extends true>=T;
    type Names=Assert<Equal<InvalidatableEventName,'ui.render'|'prompt.section'|'prompt.context'|'prompt.attachment'|'tool.describe'|'command.describe'|'config.describe'>>;
    declare const selected:InvalidatableEventName;
    $.ui.invalidate(selected);
    $.ui.invalidate('ui.render'); $.ui.invalidate('prompt.section'); $.ui.invalidate('prompt.context');
    $.ui.invalidate('prompt.attachment'); $.ui.invalidate('tool.describe'); $.ui.invalidate('command.describe'); $.ui.invalidate('config.describe');
    // @ts-expect-error UI effects are not invalidatable render/catalog events.
    $.ui.invalidate('ui.open');
    // @ts-expect-error Arbitrary strings do not acquire invalidation admission.
    $.ui.invalidate('unsupported-event');
    export type {Names};
  `)).toEqual([])
})
