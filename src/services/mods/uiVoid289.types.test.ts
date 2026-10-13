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

test('public notification calls and canonical operations match official 289 exactly',()=>{
 expect(diagnostics(`import type{EngineInterface,UiLogSink,UiLogOptions,ToastOptions,OpEventOf,OpValueOf,OpEventResult,EventOf,ResultOf,On}from 'claude-code';import type{EngineCall}from 'claude-code/testing';
 type Equal<A,B>=(<T>()=>T extends A?1:2)extends(<T>()=>T extends B?1:2)?true:false;type Assert<T extends true>=T;
 type Sink=Assert<Equal<UiLogSink,'transcript'|'debug'>>;
 type LogOptions=Assert<Equal<UiLogOptions,{to?:UiLogSink}>>;type Toast=Assert<Equal<ToastOptions,{timeoutMs?:number}>>;
 type Log=Assert<Equal<EngineInterface['ui']['log'],(text:string,options?:UiLogOptions)=>void>>;
 type Status=Assert<Equal<EngineInterface['ui']['status'],(text:string|undefined)=>void>>;
 type Show=Assert<Equal<EngineInterface['ui']['toast'],(text:string,options?:ToastOptions)=>void>>;
 type LogInput=Assert<Equal<OpEventOf['ui.log'],{text:string;to:UiLogSink}>>;
 type StatusInput=Assert<Equal<OpEventOf['ui.status'],{text:string|undefined}>>;
 type ToastInput=Assert<Equal<OpEventOf['ui.toast'],{text:string;timeoutMs?:number}>>;
 type Value=Assert<Equal<OpValueOf['ui.log']|OpValueOf['ui.status']|OpValueOf['ui.toast'],void>>;
 type Envelope={value:void;deny?:undefined}|{deny:string;value?:undefined};
 type Result=Assert<Equal<ResultOf['ui.log'],Envelope>>;type Operation=Assert<Equal<OpEventResult<'ui.status'>,Envelope>>;
 type Event=Assert<Equal<EventOf['ui.toast'],{text:string;timeoutMs?:number}>>;
 declare const $:EngineInterface,on:On,call:EngineCall<'ui.log'>;
 const log: void=$.ui.log('line');const status:void=$.ui.status(undefined);const toast:void=$.ui.toast('notice');
 const canonical:Promise<Envelope>=call({text:'line',to:'debug'});
 on('ui.log',async($,e,next)=>{const sink:UiLogSink=e.to;const result:Envelope=await next({...e,to:'debug'});return result});
 on('ui.status',()=>({deny:'held'}));on('ui.toast',()=>({value:undefined}));
 const options:UiLogOptions={};options.to='debug';const timeout:ToastOptions={};timeout.timeoutMs=4000;
 void[log,status,toast,canonical,options,timeout];export type{Sink,LogOptions,Toast,Log,Status,Show,LogInput,StatusInput,ToastInput,Value,Result,Operation,Event};`)).toEqual([])
})

test('author types keep string arguments, require an explicit status clear and preserve generic receipts',()=>{
 expect(diagnostics(`import type{EngineInterface,On}from 'claude-code';import type{Engine,EngineCall}from 'claude-code/testing';declare const $:EngineInterface,on:On,testEngine:Engine,call:EngineCall<'ui.log'>;
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
 $.ui.toast('notice',{timeoutMs:'4000'});
 // @ts-expect-error Canonical log input requires a sink.
 call({text:'line'});
 // @ts-expect-error No bare undefined operation receipt.
 on('ui.log',()=>undefined);
 // @ts-expect-error No arbitrary operation value.
 on('ui.status',()=>({value:'line'}));
 // @ts-expect-error Testing Engine does not expose production notification sugar.
 testEngine.ui.log('line');`)).toEqual([])
})
