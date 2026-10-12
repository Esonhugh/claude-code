import {createHash} from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import legacyDeclarations from './fixtures/legacy280-declarations.json'
import ts from 'typescript'
import { z } from 'zod/v4'
import type { Tool } from '../../Tool.js'
import { ensureModDeclarations, generateModDeclarationFiles } from './declarations.js'
import { createModsRuntime } from './runtime.js'
import officialDeclaration from '../../../assets/mods-2.1.292.d.ts.txt' with {type: 'text'}

const repository = new URL('../../../', import.meta.url).pathname

function source(version = '0.0.0-test'): string {
  return generateModDeclarationFiles(version).find(file => file.path === 'claude-code/index.d.ts')!.text
}

async function fixture(name: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), `mods-declarations-${name}-`)))
}

const compilerOptions: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2023.d.ts'],
  types: [],
  jsx: ts.JsxEmit.React,
  jsxFactory: 'h',
  jsxFragmentFactory: 'Fragment',
}

const librarySyntax = new Map<string, ts.SourceFile>()
function withLibrarySyntax(host: ts.CompilerHost, options: ts.CompilerOptions, virtual: Readonly<Record<string, string>> = {}): ts.CompilerHost {
  const libraryDirectory = dirname(ts.getDefaultLibFilePath(options))
  const parserOptions = JSON.stringify({ ...options, skipLibCheck: undefined })
  const parse = host.getSourceFile.bind(host)
  host.getSourceFile = (file, languageVersion, onError, fresh) => {
    if (Object.hasOwn(virtual, file) || dirname(file) !== libraryDirectory) return parse(file, languageVersion, onError, fresh)
    const key = `${parserOptions}:${file}`
    const cached = librarySyntax.get(key)
    if (cached && !fresh) return cached
    const parsed = parse(file, languageVersion, onError, fresh)
    if (parsed) librarySyntax.set(key, parsed)
    return parsed
  }
  return host
}

// Keep local and reference builders separate: swapping global declarations invalidates cached library diagnostics.
const typecheckPrograms = new Map<string, ts.SemanticDiagnosticsBuilderProgram>()

function diagnostics(files: Readonly<Record<string, string>>, roots: readonly string[], overrides: ts.CompilerOptions = {}): readonly ts.Diagnostic[] {
  const dependencies = { ...files }
  const options: ts.CompilerOptions = { ...compilerOptions, ...overrides }
  const check = (input: Readonly<Record<string, string>>, variant: 'local' | 'official') => {
    const host = withLibrarySyntax(ts.createIncrementalCompilerHost(options), options, input)
    const read = host.readFile.bind(host)
    const exists = host.fileExists.bind(host)
    const directoryExists = host.directoryExists?.bind(host)
    host.directoryExists = directory => Object.keys(input).some(file => file.startsWith(`${directory}/`)) || directoryExists?.(directory) === true
    host.readFile = file => input[file] ?? read(file)
    host.fileExists = file => Object.hasOwn(input, file) || exists(file)
    const key = `${variant}:${JSON.stringify(options)}`
    const program = ts.createSemanticDiagnosticsBuilderProgram([...roots], options, host, typecheckPrograms.get(key))
    typecheckPrograms.set(key, program)
    return ts.sortAndDeduplicateDiagnostics([
      ...program.getConfigFileParsingDiagnostics(),
      ...program.getOptionsDiagnostics(),
      ...program.getSyntacticDiagnostics(),
      ...program.getGlobalDiagnostics(),
      ...program.getSemanticDiagnostics(),
      ...((options.declaration ?? options.composite) ? program.getDeclarationDiagnostics() : []),
    ])
  }
  const official = Object.fromEntries(Object.entries(dependencies).map(([path, text]) => [path, text.includes('// Claude Code function hooks:') ? officialDeclaration : text]))
  const result = check(dependencies, 'local')
  expect(messages(result)).toBe(messages(check(official, 'official')))
  return result
}

function messages(items: readonly ts.Diagnostic[]): string {
  return items.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('\n')
}

describe('generated Mods declarations', () => {
  test('types official fs.read overloads and required stat option fields', () => {
    const declaration = '/virtual/claude-code.d.ts'
    const plugin = '/virtual/fs-options.ts'
    const files = {
      [declaration]: source(),
      [plugin]: `import type {EngineInterface,FsBytes,FsReadAs,FsReadCall,FsReadBytesOptions,FsReadOptions,FsStat,FsStatOptions} from 'claude-code';
        declare const $:EngineInterface;
        declare const as:FsReadAs;
        const read:FsReadCall=$.fs.read;
        const bytesOptions:FsReadBytesOptions={as:'bytes'};
        const options:FsReadOptions={as};
        const statOptions:FsStatOptions={resolve:false};
        const text:Promise<string>=read('file');
        const bytes:Promise<FsBytes>=read('file',bytesOptions);
        const either:Promise<string|FsBytes>=read('file',options);
        const explicitText:Promise<string|FsBytes>=read('file',{as:'text'});
        const stat:Promise<FsStat>=$.fs.stat('file');
        const statWithOptions:Promise<FsStat>=$.fs.stat('file',statOptions);
        // @ts-expect-error Explicit options must carry the representation.
        $.fs.read('file',{});
        // @ts-expect-error Explicit options must carry resolve.
        $.fs.stat('file',{});
        // @ts-expect-error The official general overload remains a union even for explicit text.
        const textOnly:Promise<string>=$.fs.read('file',{as:'text'});
        // @ts-expect-error Raw bytes return a base64 receipt, not text.
        const bytesAsText:Promise<string>=$.fs.read('file',{as:'bytes'});
        void [text,bytes,either,explicitText,stat,statWithOptions,textOnly,bytesAsText];`,
    }
    expect(messages(diagnostics(files, [declaration, plugin], {skipLibCheck:false}))).toBe('')
  })

  test('preserves each official PromptOrigin branch for author Extract types', () => {
    const declaration = '/virtual/claude-code.d.ts'
    const localDeclaration = '/virtual/local-origin.ts'
    const plugin = '/virtual/prompt-origin-branches.ts'
    const kinds = ['composer', 'bridge', 'sdk', 'task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay', 'coordinator', 'observer', 'observer-activity', 'auto-continuation', 'unclassified', 'slack-ping']
    const adapter = ts.createSourceFile('promptAdapter.ts', readFileSync(new URL('./promptAdapter.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
    const alias = adapter.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'PromptOrigin')!
    const local = ts.createPrinter().printNode(ts.EmitHint.Unspecified, alias, adapter)
    const checks = ['PromptOrigin', 'LocalPromptOrigin'].flatMap(type => kinds.map((kind, index) => `const ${type}_${index}: Extract<${type}, {kind:'${kind}'}> = {kind:'${kind}'};`)).join('\n')
    const files = {
      [declaration]: source(),
      [localDeclaration]: local,
      [plugin]: `import type {PromptOrigin} from 'claude-code';
        import type {PromptOrigin as LocalPromptOrigin} from './local-origin';
        ${checks}
        const pluginOrigin: Extract<PromptOrigin,{kind:'plugin'}>={kind:'plugin',name:'fixture',asUser:true};
        const channelOrigin: Extract<PromptOrigin,{kind:'channel'}>={kind:'channel',server:'fixture'};
        // @ts-expect-error Composer cannot acquire another origin's fields.
        const forged: Extract<PromptOrigin,{kind:'composer'}>={kind:'composer',server:'foreign'};
        // @ts-expect-error Plugin origin requires its name.
        const unnamed: Extract<PromptOrigin,{kind:'plugin'}>={kind:'plugin'};
        void [pluginOrigin,channelOrigin,forged,unnamed];`,
    }
    expect(messages(diagnostics(files, [declaration, localDeclaration, plugin], { skipLibCheck: false }))).toBe('')
  })

  test('types prompt submit provenance, asUser and precise hook and call receipts', () => {
    const declaration = '/virtual/claude-code.d.ts'
    const plugin = '/virtual/prompt-submit.ts'
    const files = {
      [declaration]: source(),
      [plugin]: `import type {Register,PromptOrigin,PromptSubmitArgs,PromptSubmitAttachment,PromptSubmitInput,PromptSubmitResult} from 'claude-code';
        const origin:PromptOrigin={kind:'plugin',name:'fixture',asUser:true};
        const image:PromptSubmitAttachment={type:'image',mediaType:'image/png',filename:'shot.png'};
        const input:PromptSubmitInput={text:'words',origin,wait:false,attachments:[image]};
        const args:PromptSubmitArgs={text:'words',asUser:true,attachments:[image]};
        // @ts-expect-error Runtime accepts false as absence, but the official author type accepts only true.
        const no:PromptSubmitArgs={text:'words',asUser:false};
        // @ts-expect-error Public callers do not set provenance.
        const forged:PromptSubmitArgs={text:'words',origin};
        // @ts-expect-error A plugin origin requires its real name.
        const unnamed:PromptOrigin={kind:'plugin',asUser:true};
        export const register:Register=on=>{
          on('session.start',async($,e,next)=>{
            const result:PromptSubmitResult=await $.prompt.submit(args);
            if(result.drop===undefined){const text:string=result.text;const o:PromptOrigin|undefined=result.origin;void [text,o];}
            else{const reason:string=result.drop;void reason;}
            return next(e);
          });
          on('prompt.submit',async(_,e,next)=>{
            const text:string=e.text;const wait:boolean=e.wait;const o:PromptOrigin=e.origin;
            const receipt:PromptSubmitResult=await next({...e,text});
            // @ts-expect-error The event text is a string.
            const bad:number=e.text;
            void [input,wait,o,bad];return receipt;
          });
        };`,
    }
    expect(messages(diagnostics(files, [declaration, plugin], { noUncheckedIndexedAccess: true }))).toBe('')
  })

  test('types official Button props and the complete press event delivered to its closure', () => {
    const declaration = '/virtual/claude-code.d.ts'
    const plugin = '/virtual/button.ts'
    const files = {
      [declaration]: source(),
      [plugin]: `import type {Register,ButtonProps,UiPressArgument,PressedLink,RenderSurface,TextHoverProps} from 'claude-code';
        const hover:TextHoverProps={scope:'save',color:'suggestion',backgroundColor:'black',bold:true};
        const link:PressedLink={href:'https://example.com'};
        const props:ButtonProps={label:'Save',hotkey:'s',action:'app:cycleDiffBase',variant:'primary',role:'dismiss',autoFocus:true,hover,onPress:e=>{
          const surface:RenderSurface=e.surface;
          const identity:string=e.plugin+e.element+e.component+e.requestId;
          const href:string|undefined=e.link?.href;
          void [surface,identity,href,link];
        }};
        const press:UiPressArgument={plugin:'owner',element:'save',component:'Pane',requestId:'panel',surface:'terminal'};
        // @ts-expect-error Invalid Button variants are refused.
        const badVariant:ButtonProps={...props,variant:'danger'};
        // @ts-expect-error Only the dismiss role is defined.
        const badRole:ButtonProps={...props,role:'submit'};
        // @ts-expect-error The event identifies its originating surface.
        const missingSurface:UiPressArgument={plugin:'owner',element:'save',component:'Pane',requestId:'panel'};
        export const register:Register=on=>on('ui.render',($,e)=>{
          const {Button}=$.ui.resolve(e);
          return Button({...props,onPress:received=>{const event:UiPressArgument=received;void event;}});
        });
        void [press,badVariant,badRole,missingSurface];`,
    }
    expect(messages(diagnostics(files, [declaration, plugin], { skipLibCheck: false }))).toBe('')
  })

  test('types official file modification times and independent process truncation flags', () => {
    const declaration = '/virtual/claude-code.d.ts'
    const plugin = '/virtual/host-results.ts'
    const files = {
      [declaration]: source(),
      [plugin]: `import type {Register,FsEntry,ProcessRunResult} from 'claude-code';
        const file:FsEntry={name:'file',kind:'file',size:2,mtimeMs:123,isLink:false};
        const done:ProcessRunResult={exitCode:0,stdout:'',stderr:'',isStdoutTruncated:false,isStderrTruncated:false};
        // @ts-expect-error Every directory entry must carry mtimeMs too.
        const incomplete:FsEntry={name:'dir',kind:'dir',size:0,isLink:false};
        // @ts-expect-error Process results must describe both pipes.
        const missingPipe:ProcessRunResult={exitCode:0,stdout:'',stderr:'',isStdoutTruncated:false};
        export const register:Register=on=>on('tool.call',async($)=>{
          const entries:readonly FsEntry[]=await $.fs.list();
          const result:ProcessRunResult=await $.process.run(['echo','hello']);
          const times:number[]=entries.map(e=>e.mtimeMs);
          const clipped:boolean=result.isStdoutTruncated || result.isStderrTruncated;
          return {result:{times,clipped,file,done}};
        });`,
    }
    expect(messages(diagnostics(files, [declaration, plugin], { skipLibCheck: false }))).toBe('')
  })

  test('permits the ignored registration results of concise and asynchronous authors', () => {
    const declaration = '/virtual/claude-code.d.ts'
    const plugin = '/virtual/concise-register.ts'
    const files = {
      [declaration]: source(),
      [plugin]: `import type { Register } from 'claude-code';
        export const concise: Register = on => on('session.start', (_, event, next) => next(event));
        export const asynchronous: Register = async on => on('session.start', (_, event, next) => next(event));
        export const ignoredValue: Register = on => { on('session.start', (_, event, next) => next(event)); return 123; };`,
    }
    expect(messages(diagnostics(files, [declaration, plugin], { skipLibCheck: false }))).toBe('')
  })
  test('types named transcript and normalized API-form overloads without widening main reads', () => {
    const declaration='/virtual/claude-code.d.ts', plugin='/virtual/session-options.ts'
    const files={
      [declaration]:source(),
      [plugin]:`import type {Register,SessionMessage,ApiMessage,SessionMessagesArgs,SessionMessagesValue,ToolUseSummary} from 'claude-code';
        const args:SessionMessagesArgs={agentId:'child',as:'api'};
        const use:ToolUseSummary={tool_use_id:'id',tool:'Agent',input:{},agentId:'child',durationMs:120};
        export const register:Register=on=>{
          on('tool.call',async ($)=>{
            const rows:readonly SessionMessage[]=await $.session.messages();
            const main:readonly ApiMessage[]=await $.session.messages({as:'api'});
            const child:SessionMessagesValue=await $.session.messages(args);
            if(Array.isArray(child)) { const role:'user'|'assistant'=child[0]?.role ?? 'user'; }
            // @ts-expect-error Named reads can deny and must be narrowed first.
            const unchecked:readonly SessionMessage[]=await $.session.messages({agentId:'child'});
            // @ts-expect-error Only the api representation is supported.
            $.session.messages({as:'text'});
            // @ts-expect-error No unknown request fields are admitted.
            $.session.messages({sessionId:'foreign'});
            return {result:{rows,main,child}};
          });
          on('session.messages',(_,e,next)=>{
            const agent:string|undefined=e.agentId;
            const form:'api'|undefined=e.as;
            return next(e);
          });
          // @ts-expect-error A transcript hook must return its value/deny envelope.
          on('session.messages',()=>({value:'legacy string'}));
        };`,
    }
    expect(messages(diagnostics(files,[declaration,plugin],{skipLibCheck:false}))).toBe('')
  })
  test('types per-call model effort, deadlines and local signal options', () => {
    const declaration='/virtual/claude-code.d.ts', plugin='/virtual/model-options.ts'
    const files={
      [declaration]:source(),
      [plugin]:`import type {Register,ModelEffort,ModelCompleteRequest,ModelCompleteOptions} from 'claude-code';
        const levels:ModelEffort[]=['low','medium','high','xhigh','max'];
        const ask:ModelCompleteRequest={model:'haiku',prompt:'data',effort:'low',timeoutMs:100};
        const options:ModelCompleteOptions={signal:new AbortController().signal};
        export const register:Register=on=>{
          on('tool.call',async ($)=>({result:await $.model.complete(ask,options)}));
          on('model.complete',(_,e,next)=>{
            const effort:ModelEffort|undefined=e.effort;
            const timeout:number|undefined=e.timeoutMs;
            // @ts-expect-error Local options are not request event fields.
            e.signal;
            return next(e);
          });
          // @ts-expect-error Middleware must return the structured result envelope.
          on('model.complete',()=>({value:'legacy reply'}));
        };
        // @ts-expect-error Only the five public effort levels are admitted.
        const bad:ModelCompleteRequest={model:'haiku',prompt:'data',effort:'ultra'};
        // @ts-expect-error Only a signal belongs in call options.
        const badOptions:ModelCompleteOptions={timeoutMs:100};`,
    }
    expect(messages(diagnostics(files,[declaration,plugin],{skipLibCheck:false}))).toBe('')
  })
  test('types structured model results and narrows every result branch', () => {
    const declaration='/virtual/claude-code.d.ts', plugin='/virtual/model.ts'
    const files = {
      [declaration]: source(),
      [plugin]: `import type {Register,ModelCompleteRequest,ModelCompleteResult,ModelForkResult,ModelApiError,ModelUsage} from 'claude-code';
        const usage:ModelUsage={input_tokens:1,output_tokens:2,cache_read_input_tokens:3,cache_creation_input_tokens:4};
        const kinds:ModelApiError[]=['overloaded','oauth_org_not_allowed','account_on_hold','verification_required','model_not_found','cloud_credential_error'];
        export const register:Register=on => {
          on('tool.call',async ($) => {
            const ask:ModelCompleteRequest={model:'haiku',prompt:'hello'};
            const result:ModelCompleteResult=await $.model.complete(ask);
            if(result.isAnswered) { const text:string=result.text; const cost:number=result.usage.output_tokens; }
            else if(result.reason==='api-error') { const status:number|null=result.status; const kind:ModelApiError=result.error; }
            else { const cost:ModelUsage=result.usage; }
            const fork:ModelForkResult=await $.model.fork({prompt:'hello'});
            if(!fork.isAnswered && fork.reason==='nothing-to-fork') {
              // @ts-expect-error No request was made in the cold branch.
              fork.usage;
            }
            // @ts-expect-error No successful reply is known before narrowing.
            result.text;
            // @ts-expect-error The model is required.
            $.model.complete({prompt:'hello'});
            return {result};
          });
        };`,
    }
    expect(messages(diagnostics(files,[declaration,plugin]))).toBe('')
  })

  test('types the testing event driver namespaces without production call signatures', () => {
    const declaration = '/virtual/claude-code.d.ts'
    const plugin = '/virtual/tests/events.test.ts'
    const files = {
      [declaration]: source(),
      [plugin]: `import { test } from 'claude-code/testing';
        import type { HookStream, TurnStepChunk, TurnStepResult } from 'claude-code';
        test('current metadata events', async ($, on) => {
          on('session.cwd', () => ({value:'fixture'}));
          // @ts-expect-error Metadata is a production operation, not a testing Engine convenience.
          const cwd: unknown = await $.session.cwd();
          // @ts-expect-error Metadata is outside the official EventCalls surface.
          await $.session.root();
          // @ts-expect-error Metadata is outside the official EventCalls surface.
          await $.session.model();
          // @ts-expect-error Metadata is outside the official EventCalls surface.
          await $.session.turns();
          // @ts-expect-error Metadata is outside the official EventCalls surface.
          await $.session.id();
          // @ts-expect-error Metadata is outside the official EventCalls surface.
          await $.session.repo();
          // @ts-expect-error Metadata is outside the official EventCalls surface.
          await $.session.surface();
          // @ts-expect-error Metadata is outside the official EventCalls surface.
          await $.session.surfaces();
          // @ts-expect-error Metadata is outside the official EventCalls surface.
          await $.session.messages();
          // @ts-expect-error Metadata is outside the official EventCalls surface.
          await $.session.authorize();
          // @ts-expect-error Metadata is outside the official EventCalls surface.
          await $.session.version();
          // @ts-expect-error HTTP operations are outside the official EventCalls surface.
          const http: unknown = await $.http.fetch({url:'https://example.invalid'});
          const result: import('claude-code').CommandRunResult = await $.command.run({command:'hello',args:'',origin:{kind:'composer'},presentation:{columns:120,isFullscreen:true}});
          const stream: HookStream<TurnStepChunk, TurnStepResult> = $.turn.step({model:'test',index:0,turnId:'test',messageCount:0});
          // @ts-expect-error Known namespaces do not expose unsupported methods.
          $.session.unimplemented();
          // @ts-expect-error HTTP operations are absent regardless of argument spelling.
          $.http.fetch('https://example.invalid');
        });`,
    }
    expect(messages(diagnostics(files, [declaration, plugin], {noUncheckedIndexedAccess:true}))).toBe('')
  })

  test('types all admitted session and HTTP hook names and negated patterns', () => {
    const declaration = '/virtual/claude-code.d.ts'
    const plugin = '/virtual/hooks.ts'
    const files = {
      [declaration]: source(),
      [plugin]: `import type { Register, EventName, Pattern } from 'claude-code';
        const events = ['session.cwd','session.root','session.model','session.turns',
          'session.id','session.repo','session.surface','session.surfaces','session.messages',
          'session.authorize','http.fetch'] as const satisfies readonly EventName[];
        // @ts-expect-error The official negation excludes the universal wildcard.
        const allButAll: Pattern = '!*';
        export const register: Register = on => {
          // Literal patterns preserve the official On overload's contextual types.
          on('session.cwd', (_, e, next) => next(e));
          on('session.root', (_, e, next) => next(e));
          on('session.model', (_, e, next) => next(e));
          on('session.turns', (_, e, next) => next(e));
          on('session.id', (_, e, next) => next(e));
          on('session.repo', (_, e, next) => next(e));
          on('session.surface', (_, e, next) => next(e));
          on('session.surfaces', (_, e, next) => next(e));
          on('session.messages', (_, e, next) => next(e));
          on('session.authorize', (_, e, next) => next(e));
          on('http.fetch', (_, e, next) => next(e));
          on('session.cwd', (_, e, next) => next(e));
          on('!http.fetch', (_, e, next) => next(e));
          // @ts-expect-error No official pattern negates every event.
          on('!*', (_, e, next) => next(e));
          // @ts-expect-error Unsupported core methods are not admitted hook events.
          on('session.unimplemented', (_, e, next) => next(e));
        };`,
    }
    expect(messages(diagnostics(files, [declaration, plugin]))).toBe('')
  })

  test('types trace inputs, results and optional stream counts without making data writable', () => {
    const declaration = '/virtual/claude-code.d.ts'
    const plugin = '/virtual/trace.ts'
    const files = {
      [declaration]: source(),
      [plugin]: `import type { Next, TraceEntry, TraceOutcome } from 'claude-code';
        declare module 'claude-code' { interface EngineInterface { greeting: {read(input:{text:string}):Promise<string>} } }
        declare const next: Next;
        const entry = next.trace[0];
        const received: unknown = entry.received;
        const returned: unknown = entry.returned;
        const chunks: number | undefined = entry.chunks;
        const outcome: TraceOutcome = entry.outcome;
        const typed: TraceEntry<'greeting.read', {text:string}, {value:string}> = {
          index:0, plugin:'greeting', tier:'user', event:'greeting.read', outcome:'returned',
          ms:1, received:{text:'hello'}, returned:{value:'hello'},
        };
        const text: string = typed.received.text;
        const answer: string | undefined = typed.returned?.value;
        // @ts-expect-error Trace metadata is immutable.
        entry.chunks = 1;
        // @ts-expect-error The dispatcher has a finite set of outcomes.
        const invalid: TraceOutcome = 'success';`,
    }
    expect(messages(diagnostics(files, [declaration, plugin]))).toBe('')
  })

  test('types engine construction and custom noun hooks from an augmented interface', () => {
    const declaration = '/virtual/claude-code.d.ts'
    const plugin = '/virtual/custom.ts'
    const files = {
      [declaration]: source(),
      [plugin]: `import type { Register, EngineCreateInput, EngineCreateResult, EngineInterfaceBuilt, NounEventOf } from 'claude-code';
        declare module 'claude-code' {
          interface EngineInterface {
            greeting: { read(input:{text:string}): Promise<string>; reset(): void; label?: string };
          }
        }
        const args: NounEventOf['greeting.read'] = {text:'hello'};
        export const register: Register = on => {
          on('engine.create', async ($, e, next) => {
            const input: EngineCreateInput = e;
            const names: readonly string[] = input.plugins;
            const beneath: EngineInterfaceBuilt = await next(e);
            const belowCore: EngineInterfaceBuilt = await next.to(e, 'core');
            // @ts-expect-error The engine is not built during engine.create.
            $.clock.now();
            const result: EngineCreateResult = {...beneath,greeting:{
              read:async (input:{text:string}) => input.text,
              reset:() => {},
            }};
            return result;
          });
          on('greeting.read', async ($, e, next) => {
            const text: string = e.text;
            const result = await next({...e,text:text+':middleware'});
            if ('deny' in result) return result;
            const value: string = result.value;
            const recorded: string | undefined = next.trace[0]?.returned && 'value' in next.trace[0].returned
              ? next.trace[0].returned.value : undefined;
            return {value};
          });
          on('greeting.reset', (_, e, next) => next(e));
          // @ts-expect-error Only function members become hook events.
          on('greeting.label', (_, e, next) => next(e));
          // @ts-expect-error A missing custom method is not a hook event.
          on('greeting.missing', (_, e, next) => next(e));
          // @ts-expect-error Custom middleware must return the declared value or deny.
          on('greeting.read', () => ({value:1}));
          // @ts-expect-error A custom invocation retains its declared object input.
          on('greeting.read', (_, e, next) => next({text:1}));
        };`,
    }
    expect(messages(diagnostics(files, [declaration, plugin]))).toBe('')
  })

  test('types the implemented repository and transcript projections', () => {
    const declaration = '/virtual/claude-code.d.ts'
    const plugin = '/virtual/session.ts'
    const files = {
      [declaration]: source(),
      [plugin]: `import type { EngineInterface, SessionRepo, SessionMessage, ToolUseSummary, ToolResultSummary } from 'claude-code';
        declare const $: EngineInterface;
        async function inspect() {
          const repo: SessionRepo | null = await $.session.repo();
          const root: string | undefined = repo?.root;
          const remote: string | null | undefined = repo?.remote;
          const internal: boolean | undefined = repo?.internal;
          const name: string | null | undefined = repo?.name;
          const rows: readonly SessionMessage[] = await $.session.messages();
          const text: string = rows[0].text;
          const use: ToolUseSummary = rows[0].toolUses[0];
          const result: ToolResultSummary | undefined = rows[0].toolResults?.[0];
          const error: true | undefined = use.isError;
          const failed: boolean | undefined = result?.isError;
          // @ts-expect-error A named read can deny and must be narrowed before use as rows.
          const named:readonly SessionMessage[] = await $.session.messages({agentId:'another'});
          // @ts-expect-error Repository roots retain their official string type.
          repo!.root = 7;
        }`,
    }
    expect(messages(diagnostics(files, [declaration, plugin]))).toBe('')
  })

  test('types prompt box reads, filled drafts and suggestion receipts', () => {
    const declaration = '/virtual/claude-code.d.ts'
    const plugin = '/virtual/prompt.ts'
    const files = {
      [declaration]: source(),
      [plugin]: `import type { Register, PromptBox, PromptFillArgs, PromptFilled, PromptSuggestArgs, PromptSuggestResult } from 'claude-code';
        export const register: Register = on => {
          on('tool.call', async ($, e, next) => {
            const box: PromptBox = await $.prompt.read();
            const text: string = box.text;
            const cursor: number = box.cursor;
            const input: PromptFillArgs = {text,mode:'insert'};
            const filled: PromptFilled = await $.prompt.fill(input);
            const changed: boolean = filled.isFilled;
            const after: string = filled.text;
            const offset: number = filled.cursor;
            const suggestion: PromptSuggestArgs = {text:'continue'};
            const receipt: PromptSuggestResult = await $.prompt.suggest(suggestion);
            const shown: boolean = receipt.isShown;
            // @ts-expect-error The draft is a box with text and cursor, not a string.
            const bare: string = await $.prompt.read();
            return next(e);
          });
        };`,
    }
    expect(messages(diagnostics(files, [declaration, plugin]))).toBe('')
  })
  test('types clock cancellation handles and abortable sleep', () => {
    const declaration = '/virtual/claude-code.d.ts'
    const plugin = '/virtual/clock.ts'
    const files = {
      [declaration]: source(),
      [plugin]: `import type { Register, Timer, TimerCall, SleepOptions } from 'claude-code';
        export const register: Register = on => {
          on('tool.call', async ($, e, next) => {
            const options: SleepOptions = {signal:next.signal};
            await $.clock.sleep(10, options);
            const after: TimerCall = $.clock.after;
            const timer: Timer = after(100, () => {});
            const interval: Timer = $.clock.every(100, async () => {});
            const cancelled: void = timer.cancel();
            interval.cancel();
            // @ts-expect-error Timers are synchronous cancellation handles.
            const pending: Promise<unknown> = timer;
            return next(e);
          });
        };`,
    }
    expect(messages(diagnostics(files, [declaration, plugin]))).toBe('')
  })
  test('types session version metadata and its observable event', () => {
    const declaration = '/virtual/claude-code.d.ts'
    const plugin = '/virtual/version.ts'
    const files = {
      [declaration]: source(),
      [plugin]: `import type { Register, SessionVersion, EventName } from 'claude-code';
        const event: EventName = 'session.version';
        export const register: Register = on => {
          on(event, ($, e, next) => next(e));
          on('tool.call', async $ => {
            const version: SessionVersion = await $.session.version();
            const full: string = version.version;
            const base: string | undefined = version.base;
            const builtAt: string | undefined = version.builtAt;
            // @ts-expect-error Version reads have no arguments.
            $.session.version({});
            return {result:{full,base,builtAt}};
          });
        };`,
    }
    expect(messages(diagnostics(files, [declaration, plugin]))).toBe('')
  })
  test('plugin identity is string metadata rather than host methods', () => {
    const declaration = '/virtual/claude-code.d.ts'
    const plugin = '/virtual/identity.ts'
    const files = {
      [declaration]: source(),
      [plugin]: `import type { Register } from 'claude-code';
        export const register: Register = on => {
          on('tool.call', ($) => {
            const name: string = $.plugin.name;
            const root: string = $.plugin.root;
            // @ts-expect-error Identity is metadata, not a callable capability.
            $.plugin.name();
            // @ts-expect-error The official identity definition requires string metadata.
            $.plugin.root = 7;
            return {result:{name,root}};
          });
        };`,
    }
    expect(messages(diagnostics(files,[declaration,plugin]))).toBe('')
  })
  test('typechecks the unchanged official-compatible author examples', async () => {
    for (const name of ['token-weather', 'blast-radius', 'replay-theater']) {
      const base = join(repository, 'examples/mods', name)
      const contract = join(base, 'types/index.d.ts')
      const authorTest = join(base, 'tests', `${name}.test.ts`)
      const generated = '/virtual/claude-code.d.ts'
      const errors = diagnostics({
        [generated]: source(),
        [contract]: await readFile(contract, 'utf8'),
        [authorTest]: await readFile(authorTest, 'utf8'),
      }, [generated, contract, authorTest])
      expect(messages(errors), name).toBe('')
    }
  })

  test('are deterministic and version-bound with exactly the verified295 Button extension', () => {
    expect(generateModDeclarationFiles('1.2.3')).toEqual(generateModDeclarationFiles('1.2.3'))
    const text = source('1.2.3'), header = '// Written by Claude Code 1.2.3.\n'
    expect(text.startsWith(header)).toBe(true)
    const end = text.lastIndexOf('\n// Claude Code owned declaration sha256=')
    expect(end).toBeGreaterThan(header.length)
    // The original 45 KB subset omitted public names and browser APIs. Full
    // Whole-body equality includes the two pinned official295 Button blocks;
    // the independent projection test proves every other292 byte is unchanged.
    expect(createHash('sha256').update(text.slice(text.indexOf('// Claude Code function hooks:'), end)).digest('hex')).toBe('78e405db69f99001ca9fc4e0dc1dd89776742fa5f8163f2d0779aa5a37677b25')
    expect(createHash('sha256').update(source('1.2.4').slice(source('1.2.4').indexOf('// Claude Code function hooks:'), end)).digest('hex')).toBe('78e405db69f99001ca9fc4e0dc1dd89776742fa5f8163f2d0779aa5a37677b25')
  })

  test('types register, state families, CAS, UI, usage, and the implemented testing expect', () => {
    const declaration = '/virtual/claude-code.d.ts'
    const plugin = '/virtual/plugin.ts'
    const files = {
      [declaration]: source(),
      [plugin]: `
        import type { StateSetOptions, Register, StateFamily, StateRead, StateRef } from 'claude-code'
        import type { Expect } from 'claude-code/testing'
        import { atom, derive, memberOf, read, update } from 'claude-code'
        declare module 'claude-code' {
          interface PluginState { notes: { title: string; open: StateFamily<boolean> } }
        }
        const title = { plugin: 'notes', key: 'title' } as const satisfies StateRef<'notes', 'title'>
        const open = (id: string) => ({ plugin: 'notes', key: 'open', id } as const satisfies StateRef<'notes', 'open'>)
        const cas: StateSetOptions = { ifVersion: 1 }
        declare const expect: Expect
        const register: Register = on => {
          on('session.start', async ($, event, next) => {
            const held: StateRead<string> = await $.state.get(title)
            await $.state.set(title, held.value ?? '', cas)
            await $.state.set(open('row'), true, {})
            const named = atom(title, '')
            const family = atom({plugin:'notes', key:'open'}, false)
            const combined = derive([named, memberOf(family, {requestId:'row'})], (text, flag) => flag ? text : '')
            const current: string = await read($, combined)
            await update($, named, value => value + current)
            const placement = await $.ui.open({ id: 'panel' })
            if (!placement.isPlaced) expect(placement.reason).toBeDefined()
            await $.ui.toast('notice', {timeoutMs:2500})
            const usage = await $.session.usage({ breakdown: 'summary', columns: 80 })
            const startedAt: number | undefined = usage.startedAt
            if (startedAt !== undefined) { const epoch: number = startedAt; void epoch }
            const exactEpoch: number = usage.startedAt
            void exactEpoch
            const Text = $.ui.resolve({ surface: 'terminal', component: 'Pane' }).Text
            expect(usage.context.window).toBeGreaterThan(0)
            Text({ children: event.cwd })
            // @ts-expect-error Text children must be renderable, not a raw engine event.
            Text({ children: event })
            return next(event)
          })
        }
        void register
      `,
    }
    const errors = diagnostics(files, [declaration, plugin]).filter(item => item.category === ts.DiagnosticCategory.Error)
    expect(messages(errors)).toBe('')
  })

  test.each(['turn-band', 'tool-calls'])('typechecks the unmodified official %s source and contract', async name => {
    const declaration = '/virtual/claude-code.d.ts'
    const plugin = '/virtual/hooks/register.tsx'
    const contract = '/virtual/types.ts'
    const files = {
      [declaration]: source(),
      [plugin]: await readFile(new URL(`./fixtures/official287-${name}.tsx.fixture`, import.meta.url), 'utf8'),
      [contract]: await readFile(new URL(`./fixtures/official287-${name}-types.ts.fixture`, import.meta.url), 'utf8'),
    }
    expect(messages(diagnostics(files, [declaration, plugin, contract]).filter(item => item.category === ts.DiagnosticCategory.Error))).toBe('')
  })

  test('types prompt compose facts, section scopes and capability', () => {
    const declaration = '/virtual/claude-code.d.ts'
    const plugin = '/virtual/compose.ts'
    const files = {
      [declaration]: source(),
      [plugin]: `
        import type { EngineInterface, PromptComposeInput, PromptComposeArgs, PromptComposeResult, PromptComposeSection, PromptComposeScope, PromptComposeTrait, EventName } from 'claude-code'
        declare const $: EngineInterface
        const event: EventName = 'prompt.compose'
        const scope: PromptComposeScope = 'session'
        const trait: PromptComposeTrait = 'lean'
        const facts: PromptComposeInput = { model:'model', promptModel:'model', surfaces:['terminal'], tools:['Read'], outputStyle:null, traits:[trait] }
        const args: PromptComposeArgs = { model:facts.model }
        const result: Promise<PromptComposeResult> = $.prompt.compose(args)
        const defaults: Promise<PromptComposeResult> = $.prompt.compose()
        const section: PromptComposeSection = {id:'policy', text:'policy', scope}
        // @ts-expect-error Prompt sections have only shared or session scope.
        const invalid: PromptComposeScope = 'global'
        // @ts-expect-error Compose facts cannot contain arbitrary traits.
        const invalidTrait: PromptComposeTrait = 'custom'
        const register: import('claude-code').Register = on => {
          on('prompt.compose', async (_, input, next) => {
            const facts: PromptComposeInput = input
            const result: PromptComposeResult = await next(facts)
            const appended: PromptComposeResult = await next.to(input, 'append')
            return {sections:[...result.sections, ...appended.sections]}
          })
        }
        void [event, result, defaults, section, invalid, invalidTrait, register]
      `,
    }
    expect(messages(diagnostics(files, [declaration, plugin]).filter(item => item.category === ts.DiagnosticCategory.Error))).toBe('')
  })

  test('types mounted Client input, messages, dimensions and frame advancement', () => {
    const declaration = '/virtual/claude-code.d.ts'
    const plugin = '/virtual/client.test.ts'
    const files = {
      [declaration]: source(),
      [plugin]: `
        import type { Mounted, MountKeyEvent, MountPointerEvent, MountResizeTarget } from 'claude-code/testing'
        import type { ClientKeyEvent, ClientPointerEvent } from 'claude-code'
        declare const ui: Mounted<'terminal'>
        const key: MountKeyEvent = {key:'return',ctrl:true,in:'board'}
        const pointer: MountPointerEvent = {type:'move',x:-1,y:2,fine:{x:-0.5,y:2.5},button:'left',in:'board'}
        const size: MountResizeTarget = {columns:40,rows:3,in:'board'}
        const rawKey: ClientKeyEvent = key
        const rawPointer: ClientPointerEvent = pointer
        const operations: Promise<void>[] = [ui.key(key),ui.pointer(pointer),ui.resize(size),ui.post({pick:2},{in:'board'}),ui.advance(250)]
        // @ts-expect-error Modifiers are present only when true.
        const invalidKey: ClientKeyEvent = {key:'a',ctrl:false}
        // @ts-expect-error Pointer events have a finite set of event names.
        const invalidPointer: ClientPointerEvent = {type:'click',x:0,y:0}
        // @ts-expect-error Client messages must be JSON.
        ui.post(() => {})
        void [rawKey,rawPointer,operations,invalidKey,invalidPointer]
      `,
    }
    expect(messages(diagnostics(files, [declaration, plugin]).filter(item => item.category === ts.DiagnosticCategory.Error))).toBe('')
  })

  test('types author test registration, mocks and mounted UI', () => {
    const declaration = '/virtual/claude-code.d.ts'
    const plugin = '/virtual/plugin.test.ts'
    const files = {
      [declaration]: source(),
      [plugin]: `
        import {describe, test, expect, mock, tier} from 'claude-code/testing'
        tier('user')
        // @ts-expect-error Test plugins cannot register as the engine core.
        tier('core')
        describe('band', () => test('mounts', {
          timeoutMs:1000, options:{greeting:'hello'},
          plugins:[{name:'inline', tier:'append', register(on) { on('session.start', (_, e, next) => next(e)) }}],
        }, async ($, on) => {
          const clock = mock.clock(on, {now:10})
          mock.env(on, {MODE:'test'})
          mock.store(on, {count:0})
          on('clock.now', (_, event, next) => { expect(next.event).toBe('clock.now'); return {value:clock.now()} })
          on('session.start', async ($, event, next) => {
            const now: number = await $.clock.now()
            await $.store.set('clock', now)
            return next(event)
          })
          await clock.advance(10)
          const props: import('claude-code').RenderPropsOf['AbovePrompt'] = {hasSurvey:false,isWorking:false,maxRows:24,bodyColumns:80,scroll:{offset:0,bodyRows:24},view:{}}
          const ui = await $.ui.mount({plugin:'notes',surface:'terminal',component:'AbovePrompt',props})
          await ui.drawn()
          const scope: import('claude-code/testing').ClientScope = {in:'counter'}
          await ui.drawn(scope)
          // @ts-expect-error Client scope keys are strings.
          ui.drawn({in:1})
          await ui.press({key:'hide'})
          await ui.press({key:'docs',link:{href:'https://example.com'},plugin:'other'})
          await ui.input({key:'title',text:'hello'})
          await ui.input({key:'title',text:'edit',kind:'change',plugin:'other'})
          await ui.select({key:'sort',value:'date',plugin:'other'})
          // @ts-expect-error Input text must be a string.
          ui.input({key:'title',text:1})
          // @ts-expect-error Input kind is change or submit.
          ui.input({key:'title',text:'x',kind:'press'})
          // @ts-expect-error Select requires a string value.
          ui.select({key:'sort',value:1})
          // @ts-expect-error Links require href.
          ui.press({key:'docs',link:{url:'x'}})
          const query: import('claude-code/testing').ElementQuery = {type:'Button',key:'hide',text:/hide/i,in:'board'}
          const found: import('claude-code/testing').FoundElement | undefined = await ui.find(query)
          const all: import('claude-code/testing').FoundElement[] = await ui.findAll({text:'hide'})
          // @ts-expect-error Queries are objects, not string shorthand.
          ui.find('hide')
          // @ts-expect-error Predicates are not official queries.
          ui.find(() => true)
          // @ts-expect-error Query results are asynchronous.
          ui.find({}).props
          // @ts-expect-error Found elements do not expose handlers.
          found?.press()
          void all
          await ui.unmount()
          const mounted = await $.ui.mount({plugin:'notes',surface:'terminal', component:'AbovePrompt', props})
          const surface: import('claude-code').RenderSurface = mounted.surface
          await mounted.press({key:'hide'})
          await mounted.unmount()
          void surface
        }))
      `,
    }
    expect(messages(diagnostics(files, [declaration, plugin]).filter(item => item.category === ts.DiagnosticCategory.Error))).toBe('')
  })

  test('types classic engine events, fields, and results exactly', () => {
    const declaration = '/virtual/claude-code.d.ts'
    const plugin = '/virtual/plugin.test.ts'
    const files = {
      [declaration]: source(),
      [plugin]: `
        import type {ClassicEventOf, ClassicResultOf} from 'claude-code'
        import type {ClassicEvent, ClassicFields, Engine, EngineClassic} from 'claude-code/testing'
        type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
        type Assert<T extends true> = T
        type Expected = Exclude<keyof ClassicEventOf, 'classic.PreToolUse'> extends \`classic.\${infer E}\` ? E : never
        type EventIsExact = Assert<Equal<ClassicEvent, Expected>>
        type ClassicIsExact = Assert<Equal<Engine['classic'], EngineClassic>>
        const pre: ClassicEventOf['classic.PreToolUse'] = {tool:'Bash',tool_use_id:'call',command:'mock'}
        const denied: ClassicResultOf['classic.PreToolUse'] = {deny:'blocked'}
        // @ts-expect-error PreToolUse has a flat tool envelope, not a classic SDK envelope.
        const wrongPre: ClassicEventOf['classic.PreToolUse'] = {hook_event_name:'PreToolUse',tool_name:'Bash',tool_input:{},tool_use_id:'call',session_id:'s',transcript_path:'',cwd:'/'}
        void [pre, denied, wrongPre]
        declare const $: Engine
        const minimal: ClassicFields<'SessionStart'> = {source:'clear'}
        const overrides: ClassicFields<'SessionStart'> = {
          source:'resume', session_id:'session', transcript_path:'', cwd:'/plugin', permission_mode:'plan', model:'model'
        }
        // @ts-expect-error PreToolUse runs through tool.call, not Engine.classic.
        $.classic.PreToolUse
        // @ts-expect-error The engine stamps hook_event_name and callers cannot provide it.
        $.classic.SessionStart({source:'clear', hook_event_name:'SessionStart'})
        // @ts-expect-error SessionStart source is the SDK's exact literal union.
        $.classic.SessionStart({source:'invalid'})
        // @ts-expect-error PostToolUse requires the SDK tool fields.
        $.classic.PostToolUse({tool_name:'Read'})
        const started: Promise<ClassicResultOf['classic.SessionStart']> = $.classic.SessionStart(minimal)
        const stopped: Promise<ClassicResultOf['classic.Stop']> = $.classic.Stop({stop_hook_active:false})
        const post: Promise<ClassicResultOf['classic.PostToolUse']> = $.classic.PostToolUse({
          tool_name:'Read', tool_input:{file_path:'/tmp/x'}, tool_response:'ok', tool_use_id:'tool'
        })
        started.then(result => {
          result.additionalContext?.map(text => text.toUpperCase())
          result.watchPaths?.map(path => path.toUpperCase())
          // @ts-expect-error SessionStart does not return PermissionRequest's decision.
          result.decision
        })
        void (null as unknown as EventIsExact)
        void (null as unknown as ClassicIsExact)
        void overrides
        void stopped
        void post
      `,
    }
    expect(messages(diagnostics(files, [declaration, plugin]).filter(item => item.category === ts.DiagnosticCategory.Error))).toBe('')
  })

  test('types the testing engine turn.step call as its implemented HookStream', () => {
    const declaration = '/virtual/claude-code.d.ts'
    const plugin = '/virtual/plugin.test.ts'
    const files = {
      [declaration]: source(),
      [plugin]: `
        import {test} from 'claude-code/testing'
        import type {HookStream, TurnStepChunk, TurnStepResult} from 'claude-code'
        test('nested step', async ($, on) => {
          on('turn.step', async function* ($, event, next) {
            const now: number = await $.clock.now()
            yield {kind:'text', index:0, text:String(now)}
            return yield* next(event)
          })
          on('turn.step', {model:'fake'}, async function* (_, event, next) {
            const downstream: HookStream<TurnStepChunk, TurnStepResult> = next.to(event, 'append')
            return yield* downstream
          })
          // @ts-expect-error Stream handlers must return a generator, not a Promise of one.
          on('turn.step', async () => (async function* () { yield 1 })())
          // @ts-expect-error A stream mock must not return a non-stream envelope.
          on('turn.step', () => ({value:1}))
          const stream = $.turn.step({turnId:'turn', index:0, model:'model', messageCount:1})
          const exact: HookStream<TurnStepChunk, TurnStepResult> = stream
          for await (const chunk of exact) {
            if (chunk.kind === 'text') chunk.text.toUpperCase()
          }
          const result: TurnStepResult = await stream.result
          result.toolUses.map(tool => tool.name)
          // @ts-expect-error A turn.step call returns its stream synchronously, not a Promise.
          const promised: Promise<unknown> = stream
          // @ts-expect-error The implemented call requires the complete turn.step input.
          $.turn.step({turnId:'turn', index:0})
        })
      `,
    }
    expect(messages(diagnostics(files, [declaration, plugin]).filter(item => item.category === ts.DiagnosticCategory.Error))).toBe('')
  })

  test('types shaped atoms without allowing shapes on ordinary state', () => {
    const declaration = '/virtual/claude-code.d.ts'
    const plugin = '/virtual/plugin.ts'
    const files = {
      [declaration]: source(),
      [plugin]: `
        import {atom, read, update} from 'claude-code'
        import type {EngineInterface, Shaped} from 'claude-code'
        declare module 'claude-code' { interface PluginState { notes: { versioned: Shaped<number>; plain: number } } }
        declare const $: EngineInterface
        const versioned = atom({plugin:'notes', key:'versioned'}, 0, {shape:'v2'})
        const result: Promise<number> = read($, versioned)
        update($, versioned, value => value + 1)
        // @ts-expect-error Ordinary state is not a shaped contract.
        atom({plugin:'notes', key:'plain'}, 0, {shape:'v2'})
        // @ts-expect-error An atom update must preserve its value type.
        update($, versioned, () => 'invalid')
        void result
      `,
    }
    expect(messages(diagnostics(files, [declaration, plugin]).filter(item => item.category === ts.DiagnosticCategory.Error))).toBe('')
  })

  test('rejects family references without id and wrong state values instead of widening the contract', () => {
    const declaration = '/virtual/claude-code.d.ts'
    const plugin = '/virtual/plugin.ts'
    const files = {
      [declaration]: source(),
      [plugin]: `
        import type { StateFamily, StateRef } from 'claude-code'
        declare module 'claude-code' { interface PluginState { notes: { open: StateFamily<boolean> } } }
        const missing: StateRef<'notes', 'open'> = { plugin: 'notes', key: 'open' }
        export const register = (on: import('claude-code').On) => on('session.start', async ($, e, next) => {
          await $.state.set({ plugin: 'notes', key: 'open', id: 'row' }, 'not boolean')
          return next(e)
        })
        void missing
      `,
    }
    const text = messages(diagnostics(files, [declaration, plugin]).filter(item => item.category === ts.DiagnosticCategory.Error))
    expect(text).toContain("Property 'id' is missing")
    expect(text).toContain("Argument of type 'string' is not assignable to parameter of type 'boolean'")
  })
})

const schemaTools = () => [
  { name: 'LocalRead', inputSchema: z.object({ path: z.string(), limit: z.number().optional() }), description: () => { throw new Error('must not describe') } },
  { name: 'mcp__demo__lookup', isMcp: true, inputSchema: z.object({ wrong: z.string() }), inputJSONSchema: { type: 'object', properties: { query: { type: 'string' }, mode: { enum: ['fast', 'full'] }, opaque: { $ref: '#/missing' } }, required: ['query', 'mode'] } },
] as unknown as Tool[]

describe('tool schema declarations', () => {
  test('emits local schema augmentations and checks flat calls and narrowing', () => {
    const files = Object.fromEntries(generateModDeclarationFiles('1.2.3', schemaTools()).map(file => [`/virtual/${file.path}`, file.text]))
    expect(files['/virtual/claude-code-tools/index.d.ts']).toContain('LocalRead')
    expect(files['/virtual/claude-code-mcp/index.d.ts']).toContain('mcp__demo__lookup')
    files['/virtual/author.ts'] = `
      import type { EngineInterface, ToolCallInput, BuiltinToolInputs, McpToolInputs } from 'claude-code'
      declare const $: EngineInterface
      $.tool.call({tool:'LocalRead',path:'a'})
      $.tool.call({tool:'mcp__demo__lookup',query:'x',mode:'fast'})
      // @ts-expect-error Missing required flat argument.
      $.tool.call({tool:'LocalRead'})
      // @ts-expect-error Not a nested input envelope.
      $.tool.call({tool:'LocalRead',input:{path:'a'}})
      // @ts-expect-error Wrong argument type.
      $.tool.call({tool:'LocalRead',path:1})
      // @ts-expect-error The connected MCP declaration checks its enum.
      const badMcp: McpToolInputs['mcp__demo__lookup'] = {query:'x',mode:'bad'}
      // The official generic MCP call accepts loose fields; its named table is precise.
      $.tool.call({tool:'mcp__demo__lookup',query:'x',mode:'bad'})
      declare const e: ToolCallInput
      if (e.tool === 'LocalRead') { const path: string = e.path; const id: string = e.tool_use_id }
      if (e.tool === 'mcp__demo__lookup') {
        const query: string = e.query
        // @ts-expect-error Unsupported refs stay unknown.
        const opaque: string = e.opaque
      }
      const builtin: BuiltinToolInputs['LocalRead'] = {path:'a'}
      const mcp: McpToolInputs['mcp__demo__lookup'] = {query:'x',mode:'full'}
    `
    expect(messages(diagnostics(files, Object.keys(files).filter(file => /\.tsx?$/.test(file))))).toBe('')
  })

  test('covers bounded schema forms and falls back to unknown for unsupported shapes', () => {
    const tool = { name: 'Shapes', inputJSONSchema: { type: 'object', additionalProperties: false, properties: {
      nested: { type: 'object', properties: { flag: { type: 'boolean' } }, required: ['flag'], additionalProperties: false },
      items: { type: 'array', items: { type: 'integer' } },
      nullable: { type: ['string', 'null'] },
      choice: { anyOf: [{ const: 'yes' }, { type: 'number' }] },
      both: { allOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] }] },
      record: { type: 'object', additionalProperties: { type: 'number' } },
      tuple: { type: 'array', prefixItems: [{ type: 'string' }] },
      conditional: { if: { type: 'string' }, then: { const: 'x' } },
    }, required: ['nested', 'items', 'nullable', 'choice', 'both', 'record'] } } as unknown as Tool
    const files = Object.fromEntries(generateModDeclarationFiles('1.2.3', [tool]).map(file => [`/virtual/${file.path}`, file.text]))
    files['/virtual/shapes.ts'] = `
      import type {BuiltinToolInputs} from 'claude-code'
      const value: BuiltinToolInputs['Shapes'] = {nested:{flag:true},items:[1],nullable:null,choice:'yes',both:{a:'a',b:2},record:{key:3}}
      // @ts-expect-error Nested required field is checked.
      value.nested = {}
      // @ts-expect-error Array items are checked.
      value.items = ['bad']
      // @ts-expect-error additionalProperties schema is checked for records.
      value.record = {key:'bad'}
      // @ts-expect-error Unsupported tuples stay unknown.
      const tuple: string[] = value.tuple
      // @ts-expect-error Unsupported conditionals stay unknown.
      const conditional: string = value.conditional
    `
    expect(messages(diagnostics(files, Object.keys(files).filter(file => /\.tsx?$/.test(file))))).toBe('')
  })

  test('runtime tools service writes a real author project and refreshes MCP on reconcile', async () => {
    const root = await fixture('runtime-tools')
    await installLegacyFixture(root)
    await mkdir(join(root, 'hooks'))
    await writeFile(join(root, 'hooks/register.js'), `export function register(on) { on('tool.call', (_, event, next) => next(event)) }`)
    const tools = schemaTools()
    const events: unknown[] = []
    const runtime = createModsRuntime({ services: { tools: () => tools }, onDiagnostic: event => events.push(event) })
    const plugin = { name: 'typed-tools', storageId: 'typed-tools@fixture', pluginRoot: root, entrypoints: [join(root, 'hooks/register.js')] }
    try {
      await runtime.reconcile([plugin])
      expect(events).toEqual([])
      const generated = join(root, '.claude-plugin/types')
      expect(await readFile(join(generated, 'claude-code-tools/index.d.ts'), 'utf8')).toContain('LocalRead')
      tools[1] = { ...tools[1]!, inputJSONSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false } } as Tool
      await runtime.reconcile([plugin])
      expect(events).toEqual([])
      expect(await readFile(join(generated, 'claude-code-mcp/index.d.ts'), 'utf8')).toContain('"count": number')
      await mkdir(join(root, 'tests'))
      await writeFile(join(root, 'tests/calls.ts'), `
        import type { EngineInterface, ToolCallInput, McpToolInputs } from 'claude-code'
        declare const $: EngineInterface
        $.tool.call({tool:'LocalRead',path:'a'})
        $.tool.call({tool:'mcp__demo__lookup',count:2})
        // @ts-expect-error Stale MCP schema must not be accepted.
        const stale: McpToolInputs['mcp__demo__lookup'] = {query:'old',mode:'fast'}
        // @ts-expect-error Inputs are flat.
        $.tool.call({tool:'LocalRead',input:{path:'a'}})
        // @ts-expect-error Wrong type.
        $.tool.call({tool:'LocalRead',path:2})
        declare const event: ToolCallInput
        if(event.tool === 'LocalRead') { const path: string = event.path }
      `)
      const result = Bun.spawnSync([process.execPath, join(repository, 'node_modules/typescript/bin/tsc'), '-p', join(generated, 'tsconfig.json')], { cwd: root, env: process.env })
      const output = result.stdout.toString() + result.stderr.toString()
      await writeFile(join(root, 'typecheck.log'), output)
      expect(result.exitCode, output).toBe(0)
    } finally { await runtime.dispose() }
  })

  test('refreshes tool schemas and replaces edited generated declarations', async () => {
    const root = await fixture('schema-update')
    const tools = schemaTools()
    const first = await ensureModDeclarations(root, '1.2.3', tools)
    tools[1] = { ...tools[1]!, inputJSONSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] } } as Tool
    await ensureModDeclarations(root, '1.2.3', tools)
    const text = await readFile(join(first.root, 'claude-code-mcp/index.d.ts'), 'utf8')
    expect(text).toContain('"count": number')
    expect(text).not.toContain('"query"')
    const author = await fixture('author-file')
    await mkdir(join(author, '.claude-plugin/types/claude-code'), { recursive: true })
    await writeFile(join(author, '.claude-plugin/types/claude-code/index.d.ts'), '// author owned\n')
    await ensureModDeclarations(author, '1.2.3', tools)
    expect(await readFile(join(author, '.claude-plugin/types/claude-code/index.d.ts'), 'utf8')).toBe(generateModDeclarationFiles('1.2.3', tools)[0]!.text)
    expect((await ensureModDeclarations(author, '1.2.3', tools)).written).toEqual([])
  })
})

async function installLegacyFixture(root: string): Promise<void> {
  for (const [path, text] of Object.entries(legacyDeclarations)) {
    const target = join(root, '.claude-plugin/types', path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, text)
  }
}

describe('legacy declaration migration', () => {
  test('upgrades historical bytes, preserves author files, and is idempotent', async () => {
    const root = await fixture('legacy')
    await installLegacyFixture(root)
    const sentinel = join(root, '.claude-plugin/types/author.d.ts')
    await writeFile(sentinel, '// author file\n')
    const tools = schemaTools()
    const first = await ensureModDeclarations(root, '1.2.3', tools)
    expect(first.written).toEqual(generateModDeclarationFiles('1.2.3', tools).map(file => file.path))
    for (const file of generateModDeclarationFiles('1.2.3', tools)) {
      expect(await readFile(join(first.root, file.path), 'utf8')).toBe(file.text)
    }
    expect(await readFile(sentinel, 'utf8')).toBe('// author file\n')
    expect((await ensureModDeclarations(root, '1.2.3', tools)).written).toEqual([])
  })

  test.each(['claude-code/index.d.ts', 'tsconfig.json'] as const)('replaces modified generated legacy %s and remains idempotent', async path => {
    const root = await fixture('legacy-edited')
    await installLegacyFixture(root)
    const target = join(root, '.claude-plugin/types', path)
    const edited = legacyDeclarations[path] + '\n// author customization\n'
    await writeFile(target, edited)
    await ensureModDeclarations(root, '1.2.3', schemaTools())
    expect(await readFile(target, 'utf8')).toBe(generateModDeclarationFiles('1.2.3', schemaTools()).find(file => file.path === path)!.text)
    expect((await ensureModDeclarations(root, '1.2.3', schemaTools())).written).toEqual([])
  })

  test('replaces misplaced historical bytes in the generated base declaration', async () => {
    const root = await fixture('legacy-wrong-path')
    await mkdir(join(root, '.claude-plugin/types/claude-code'), { recursive: true })
    const target = join(root, '.claude-plugin/types/claude-code/index.d.ts')
    await writeFile(target, legacyDeclarations['tsconfig.json'])
    await ensureModDeclarations(root, '1.2.3')
    expect(await readFile(target, 'utf8')).toBe(generateModDeclarationFiles('1.2.3')[0]!.text)
  })
})

describe('declaration installation', () => {
  test('generates an explicit author project and ignores generated files', () => {
    const files = generateModDeclarationFiles('1.2.3')
    const config = JSON.parse(files.find(file => file.path === 'tsconfig.json')!.text)
    expect(config.compilerOptions.types).toEqual(['claude-code','claude-code-tools','claude-code-mcp'])
    expect(config.compilerOptions.typeRoots).toEqual(['.'])
    expect(config.include).toEqual(['../../hooks', '../../types', '../../tests'])
    expect(files.find(file => file.path === '.gitignore')?.text).toBe('*\n')
  })

  test.each(['token-weather', 'blast-radius', 'replay-theater'])('resolves unchanged %s with generated tsc project', async name => {
    const root = await fixture(`project-${name}`)
    for (const directory of ['hooks', 'types', 'tests']) {
      await cp(join(repository, 'examples/mods', name, directory), join(root, directory), { recursive: true, errorOnExist: true, force: false })
    }
    await installLegacyFixture(root)
    const installed = await ensureModDeclarations(root, '1.2.3')
    for (const relativePath of ['types/index.d.ts', `tests/${name}.test.ts`]) {
      expect(await readFile(join(root, relativePath), 'utf8')).toBe(await readFile(join(repository, 'examples/mods', name, relativePath), 'utf8'))
    }
    const env = { ...process.env }
    for (const [key, directory] of Object.entries({ HOME: 'home', XDG_CONFIG_HOME: 'config', TMPDIR: 'tmp' })) {
      env[key] = join(root, directory)
      await mkdir(env[key]!, { recursive: true })
    }
    const result = Bun.spawnSync([process.execPath, join(repository, 'node_modules/typescript/bin/tsc'), '-p', join(installed.root, 'tsconfig.json'), '--listFiles'], { cwd: root, env })
    const output = result.stdout.toString() + result.stderr.toString()
    await writeFile(join(root, 'tsc.log'), output)
    expect(output).toContain(join(root, 'tests', `${name}.test.ts`))
    expect(output).toContain(join(root, 'types', 'index.d.ts'))
    expect(output).toContain(join(installed.root, 'claude-code', 'index.d.ts'))
    expect(result.exitCode, output).toBe(0)
  })

  test('concurrent installers accept directories created by another installer', async () => {
    const root = await fixture('concurrent')
    const results = await Promise.allSettled(Array.from({ length: 16 }, () => ensureModDeclarations(root, '1.2.3')))
    expect(results.filter(result => result.status === 'rejected')).toEqual([])
    for (const file of generateModDeclarationFiles('1.2.3')) {
      expect(await readFile(join(root, '.claude-plugin/types', file.path), 'utf8')).toBe(file.text)
    }
  })

  test('writes under a private temporary fixture and leaves identical bytes untouched', async () => {
    const root = await fixture('idempotent')
    const first = await ensureModDeclarations(root, '1.2.3')
    const file = join(first.root, 'claude-code', 'index.d.ts')
    const before = await stat(file)
    const second = await ensureModDeclarations(root, '1.2.3')
    const after = await stat(file)
    expect(first.written).toEqual(['claude-code/index.d.ts', 'claude-code-tools/index.d.ts', 'claude-code-mcp/index.d.ts', 'tsconfig.json', '.gitignore'])
    expect(second).toMatchObject({ written: [], unchanged: ['claude-code/index.d.ts', 'claude-code-tools/index.d.ts', 'claude-code-mcp/index.d.ts', 'tsconfig.json', '.gitignore'] })
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(await readFile(file, 'utf8')).toBe(source('1.2.3'))
  })

  test('refuses existing directory symlinks and non-directory components', async () => {
    const root = await fixture('directory-guards')
    const outside = await fixture('directory-target')
    await symlink(outside, join(root, '.claude-plugin'))
    await expect(ensureModDeclarations(root, '1.2.3')).rejects.toThrow(/symlink/)
    await expect(lstat(join(outside, 'types'))).rejects.toMatchObject({ code: 'ENOENT' })
    const blocked = await fixture('directory-blocked')
    await writeFile(join(blocked, '.claude-plugin'), 'author file\n')
    await expect(ensureModDeclarations(blocked, '1.2.3')).rejects.toThrow(/not a directory/)
    expect(await readFile(join(blocked, '.claude-plugin'), 'utf8')).toBe('author file\n')
  })

  test('replaces a generated index symlink without touching its external target', async () => {
    const root = await fixture('symlink')
    const outside = join(root, 'outside.d.ts')
    await writeFile(outside, 'evidence remains\n')
    await mkdir(join(root, '.claude-plugin', 'types', 'claude-code'), { recursive: true })
    await symlink(outside, join(root, '.claude-plugin', 'types', 'claude-code', 'index.d.ts'))
    await ensureModDeclarations(root, '1.2.3')
    expect(await readFile(outside, 'utf8')).toBe('evidence remains\n')
    const index = join(root, '.claude-plugin', 'types', 'claude-code', 'index.d.ts')
    expect((await lstat(index)).isSymbolicLink()).toBe(false)
    expect(await readFile(index, 'utf8')).toBe(generateModDeclarationFiles('1.2.3')[0]!.text)
  })
})
