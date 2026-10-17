import {expect, test} from 'bun:test'
import ts from 'typescript'
import {generateModDeclarationFiles} from './declarations.js'

function diagnostics(author: string): readonly string[] {
  const files = Object.fromEntries(generateModDeclarationFiles('2.1.289', [])
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
  const program = ts.createProgram(Object.keys(files), options, host)
  const references = program.getSourceFiles().map(file => file.fileName)
  expect(Object.keys(files).filter(path => path.endsWith('.d.ts'))).toEqual(['/virtual/claude-code/index.d.ts', '/virtual/claude-code-tools/index.d.ts', '/virtual/claude-code-mcp/index.d.ts'])
  for (const path of ['claude-code/index.d.ts', 'claude-code-tools/index.d.ts', 'claude-code-mcp/index.d.ts']) {
    expect(references).toContain(`/virtual/${path}`)
  }
  expect(program.getCompilerOptions().skipLibCheck).toBe(false)
  return ts.getPreEmitDiagnostics(program).map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n'))
}

const positive = `import type {Args,EventOf,ResultOf,InvalidatableEventName,EngineInterface,On,OpEventOf,OpValueOf,OpEventResult} from 'claude-code';
  import type {EngineCall} from 'claude-code/testing';
  type Equal<A,B>=(<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;
  type Assert<T extends true>=T;
  type Receipt={value:void;deny?:undefined}|{deny:string;value?:undefined};
  type Input=Assert<Equal<EventOf['ui.invalidate'],{event:InvalidatableEventName}>>;
  type OpInput=Assert<Equal<OpEventOf['ui.invalidate'],{event:InvalidatableEventName}>>;
  type Value=Assert<Equal<OpValueOf['ui.invalidate'],void>>;
  type OpReceipt=Assert<Equal<OpEventResult<'ui.invalidate'>,Receipt>>;
  type Result=Assert<Equal<ResultOf['ui.invalidate'],Receipt>>;
  declare const args:Args<'ui.invalidate'>,call:EngineCall<'ui.invalidate'>,prod:EngineInterface,on:On;
  const generic:Promise<Receipt>=call(args);
  const convenience:void=prod.ui.invalidate('ui.render');
  on('ui.invalidate',async($,e,next)=>{
    const event:InvalidatableEventName=e.event;
    const literal:'ui.invalidate'=next.event;
    const result:Receipt=await next({...e,event:'prompt.context'});
    return result;
  });
  on('ui.invalidate',()=>({value:undefined}));
  on('ui.invalidate',()=>({deny:'held'}));
  export type {Input,OpInput,Value,OpReceipt,Result};void [generic,convenience];
`
const negative = `import type {ResultOf,On} from 'claude-code';import type {EngineCall} from 'claude-code/testing';
  declare const call:EngineCall<'ui.invalidate'>,on:On;
  // @ts-expect-error A generic engine call takes the whole event object.
  call('ui.render');
  // @ts-expect-error The event field is restricted to the seven invalidatable names.
  call({event:'ui.open'});
  // @ts-expect-error The required event cannot be absent.
  call({});
  // @ts-expect-error Unrelated fields are not in the operation input.
  call({event:'ui.render',requestId:'owned'});
  // @ts-expect-error A receipt must contain value or deny.
  const missing:ResultOf['ui.invalidate']={};
  // @ts-expect-error The value is void.
  const value:ResultOf['ui.invalidate']={value:'unexpected'};
  // @ts-expect-error Deny is a string.
  const deny:ResultOf['ui.invalidate']={deny:4};
  // The deny branch permits its optional value to be explicitly undefined.
  const both:ResultOf['ui.invalidate']={value:undefined,deny:'both'};
  // @ts-expect-error A hook cannot return a bare void instead of the operation envelope.
  on('ui.invalidate',()=>undefined);
  on('ui.invalidate',async($,e,next)=>{
    // @ts-expect-error Hook arguments are frozen.
    e.event='prompt.context';
    // @ts-expect-error Middleware rewrites preserve the seven-name input boundary.
    await next({...e,event:'ui.close'});
    return next(e);
  });void [missing,value,deny,both];
`
const testingBoundary = `import type {Engine} from 'claude-code/testing';import type {EventCalls} from 'claude-code';
  declare const $:Engine,events:EventCalls;
  // @ts-expect-error Official testing Engine has no invalidate convenience call.
  $.ui.invalidate({event:'ui.render'});
  // @ts-expect-error EventCalls also has no invalidate convenience call.
  events.ui.invalidate('ui.render');
`
test('ui.invalidate operation input and envelope remain exact through all strict generated references',()=>{
  expect(diagnostics(positive)).toEqual([])
})
test('ui.invalidate operation rejects invalid inputs, envelope fields and frozen rewrites',()=>{
  expect(diagnostics(negative)).toEqual([])
})
test('ui.invalidate remains a production sugar and hook event without an extra testing convenience',()=>{
  expect(diagnostics(testingBoundary)).toEqual([])
})
