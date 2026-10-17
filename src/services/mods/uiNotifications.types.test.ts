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

test('public notification signatures and exported mutable options match official 289',()=>{
 expect(diagnostics(`import type{EngineInterface,UiLogSink,UiLogOptions,ToastOptions}from 'claude-code';
 type Equal<A,B>=(<T>()=>T extends A?1:2)extends(<T>()=>T extends B?1:2)?true:false;type Assert<T extends true>=T;
 type Sink=Assert<Equal<UiLogSink,'transcript'|'debug'>>;
 type LogOptions=Assert<Equal<UiLogOptions,{to?:UiLogSink}>>;type Toast=Assert<Equal<ToastOptions,{timeoutMs?:number}>>;
 type Log=Assert<Equal<EngineInterface['ui']['log'],(text:string,options?:UiLogOptions)=>void>>;
 type Status=Assert<Equal<EngineInterface['ui']['status'],(text:string|undefined)=>void>>;
 type Show=Assert<Equal<EngineInterface['ui']['toast'],(text:string,options?:ToastOptions)=>void>>;
 declare const $:EngineInterface;
 const log:void=$.ui.log('line'),status:void=$.ui.status(undefined),toast:void=$.ui.toast('notice');
 const options:UiLogOptions={};options.to='debug';const timeout:ToastOptions={};timeout.timeoutMs=4000;
 void[log,status,toast,options,timeout];export type{Sink,LogOptions,Toast,Log,Status,Show};`)).toEqual([])
})

test('public notification types require explicit status clear and return no completion promise',()=>{
 expect(diagnostics(`import type{EngineInterface}from 'claude-code';declare const $:EngineInterface;
 // @ts-expect-error Status clear requires an explicit undefined.
 $.ui.status();
 // @ts-expect-error Runtime coercion does not broaden the author type.
 $.ui.log(5);
 // @ts-expect-error Null is not an author status argument.
 $.ui.status(null);
 // @ts-expect-error Returned void is not a completion promise.
 $.ui.toast('notice').then(()=>{});
 // @ts-expect-error Sink is a closed union.
 $.ui.log('line',{to:'other'});
 // @ts-expect-error Timeout requires a number.
 $.ui.toast('notice',{timeoutMs:'4000'});`)).toEqual([])
})
