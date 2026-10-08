import { expect, test } from 'bun:test'
import ts from 'typescript'
import { generateModDeclarationFiles } from './declarations.js'

test('complete generated declarations preserve synchronous process streams and wrapped stream middleware with strict library checking', () => {
  const files: Record<string,string> = Object.fromEntries(generateModDeclarationFiles('process-spawn-test')
    .filter(file => file.path.endsWith('.d.ts')).map(file => ['/virtual/'+file.path,file.text]))
  files['/virtual/author.ts'] = `import type {EngineInterface, On, HookStream, ProcessSpawnChunk, ProcessSpawnRequest, ProcessSpawnResult} from 'claude-code';
declare const $: EngineInterface; declare const on: On;
const argv: readonly string[] = ['owned-executable'];
const stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult> = $.process.spawn({argv,input:'stdin',env:{MARKER:'owned'}});
const result: Promise<ProcessSpawnResult> = stream.result;
on('process.spawn', async function* ($, e, next) {
  const below = next({...e,argv});
  for await (const chunk of below) yield {...chunk,text:chunk.text.toUpperCase()};
  const wrapped = await below.result;
  if ('deny' in wrapped) return wrapped;
  const raw: ProcessSpawnResult = wrapped.value;
  return {value:raw};
});
// @ts-expect-error spawn returns a stream immediately, not a Promise of one.
const promise: Promise<HookStream<ProcessSpawnChunk,ProcessSpawnResult>> = $.process.spawn({argv});
// @ts-expect-error the public receipt uses code/signal, not process.run's exitCode/stdout/stderr.
const oldResult: Promise<{exitCode:number;stdout:string;stderr:string}> = stream.result;
// @ts-expect-error author input cannot supply a signal.
$.process.spawn({argv,signal:new AbortController().signal});
// @ts-expect-error author input cannot forge plugin ownership.
$.process.spawn({argv,plugin:'forged'});
// @ts-expect-error spawn has no run timeout option.
$.process.spawn({argv,timeoutMs:1});
// @ts-expect-error stdout/stderr are the only public pipes.
const badChunk: ProcessSpawnChunk = {stream:'stdin',text:'bad'};
// @ts-expect-error process.spawn middleware returns ValueOrDeny, not a raw receipt.
on('process.spawn', async function* ($, e, next) {return {code:0,signal:null}});
// @ts-expect-error exact streaming events require async generators.
on('process.spawn', async ($, e, next) => ({value:{code:0,signal:null}}));
// @ts-expect-error broad event patterns cannot use generators.
on('process.*', async function* ($, e, next) {return {value:{code:0,signal:null}}});
`
  const options: ts.CompilerOptions = {strict:true,noEmit:true,skipLibCheck:false,types:[],lib:['lib.es2023.d.ts'],target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler}
  const host = ts.createCompilerHost(options)
  const read = host.readFile.bind(host), exists = host.fileExists.bind(host)
  host.readFile = file => files[file] ?? read(file)
  host.fileExists = file => Object.hasOwn(files,file) || exists(file)
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram(Object.keys(files),options,host))
  expect(diagnostics.map(diagnostic => `${diagnostic.file?.fileName ?? ''}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText,'\n')}`)).toEqual([])
})
