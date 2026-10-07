import {expect,test} from 'bun:test'
import ts from 'typescript'
import {generateModDeclarationFiles} from './declarations.js'

function diagnostics(author:string):readonly string[]{
 const files=Object.fromEntries(generateModDeclarationFiles('2.1.289',[]).filter(f=>f.path.endsWith('.d.ts')).map(f=>['/virtual/'+f.path,f.text]))
 files['/virtual/author.ts']=author
 const options:ts.CompilerOptions={strict:true,noUncheckedIndexedAccess:true,skipLibCheck:false,noEmit:true,target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,types:[],lib:['lib.es2023.d.ts']}
 const host=ts.createCompilerHost(options),read=host.readFile.bind(host),exists=host.fileExists.bind(host),directory=host.directoryExists?.bind(host)
 host.readFile=p=>files[p]??read(p);host.fileExists=p=>Object.hasOwn(files,p)||exists(p);host.directoryExists=p=>Object.keys(files).some(f=>f.startsWith(p+'/'))||directory?.(p)===true
 return ts.getPreEmitDiagnostics(ts.createProgram(Object.keys(files),options,host)).map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n'))
}

test('copy public, canonical operation and event envelope types match official 289',()=>{
 expect(diagnostics(`import type{UiCopyArgs,UiCopyResult,RenderSurface,EngineInterface,On,Args,OpEventOf,OpValueOf,ResultOf}from 'claude-code';import type{EngineCall,Engine}from 'claude-code/testing';
 type Equal<A,B>=(<T>()=>T extends A?1:2)extends(<T>()=>T extends B?1:2)?true:false;type Assert<T extends true>=T;
 type Input=Assert<Equal<UiCopyArgs,{text:string;surface?:RenderSurface}>>;
 type Result=Assert<Equal<UiCopyResult,{isCopied:true}|{isCopied:false;reason:'no-surface'|'no-clipboard'|'refused'}>>;
 type Public=Assert<Equal<EngineInterface['ui']['copy'],(args:UiCopyArgs)=>Promise<UiCopyResult>>>;
 type Op=Assert<Equal<OpEventOf['ui.copy'],UiCopyArgs>>;type Value=Assert<Equal<OpValueOf['ui.copy'],UiCopyResult>>;
 type Envelope={value:UiCopyResult;deny?:undefined}|{deny:string;value?:undefined};type Raw=Assert<Equal<ResultOf['ui.copy'],Envelope>>;
 declare const $:EngineInterface,on:On,engine:Engine,call:EngineCall<'ui.copy'>,args:Args<'ui.copy'>;
 const done:Promise<UiCopyResult>=$.ui.copy({text:'verbatim'}),raw:Promise<Envelope>=call(args);
 on('ui.copy',{surface:'terminal'},async($,e,next)=>{const event:'ui.copy'=next.event;const text:string=e.text;return next({...e,text})});
 on('ui.copy',()=>({value:{isCopied:false,reason:'refused'}}));on('ui.copy',()=>({deny:'held'}));
 // @ts-expect-error Copy is an operation, not a testing Engine convenience call.
 engine.ui.copy({text:'x'});
 void[done,raw];export type{Input,Result,Public,Op,Value,Raw};`)).toEqual([])
})
test('copy author types reject invalid text, target and receipt branches',()=>{
 expect(diagnostics(`import type{EngineInterface,On}from 'claude-code';declare const $:EngineInterface,on:On;
 // @ts-expect-error Verbatim text is required.
 $.ui.copy({});
 // @ts-expect-error No runtime string coercion.
 $.ui.copy({text:9});
 // @ts-expect-error Surface is closed.
 $.ui.copy({text:'x',surface:'other'});
 // @ts-expect-error A failed copy has a reason.
 on('ui.copy',()=>({value:{isCopied:false}}));
 // @ts-expect-error Failure reason is closed.
 on('ui.copy',()=>({value:{isCopied:false,reason:'failed'}}));
 // @ts-expect-error Hook receipt wraps the result.
 on('ui.copy',()=>({isCopied:true}));`)).toEqual([])
})
