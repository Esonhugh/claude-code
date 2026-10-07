import {expect,test} from 'bun:test'
import ts from 'typescript'
import {generateModDeclarationFiles} from './declarations.js'

function diagnostics(author:string):readonly string[]{
 const files=Object.fromEntries(generateModDeclarationFiles('2.1.292',[]).filter(f=>f.path.endsWith('.d.ts')).map(f=>['/virtual/'+f.path,f.text]))
 files['/virtual/author.ts']=author
 const options:ts.CompilerOptions={strict:true,noUncheckedIndexedAccess:true,skipLibCheck:false,noEmit:true,target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,types:[],lib:['lib.es2023.d.ts']}
 const host=ts.createCompilerHost(options),read=host.readFile.bind(host),exists=host.fileExists.bind(host),directory=host.directoryExists?.bind(host)
 host.readFile=p=>files[p]??read(p);host.fileExists=p=>Object.hasOwn(files,p)||exists(p);host.directoryExists=p=>Object.keys(files).some(f=>f.startsWith(p+'/'))||directory?.(p)===true
 return ts.getPreEmitDiagnostics(ts.createProgram(Object.keys(files),options,host)).map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n'))
}

test('UiPane and panes convenience, event, operation and testing envelope match official 292',()=>{
 expect(diagnostics(`import type {UiPane,EngineInterface,On,Args,EventOf,ResultOf,OpEventOf,OpValueOf,OpEventResult}from 'claude-code';import type{EngineCall}from 'claude-code/testing';
 type Equal<A,B>=(<T>()=>T extends A?1:2)extends(<T>()=>T extends B?1:2)?true:false;type Assert<T extends true>=T;
 type Pane=Assert<Equal<UiPane,{id:string;title:string;isShown:boolean;isFocused:boolean;isPlaced:boolean}>>;
 type Call=Assert<Equal<EngineInterface['ui']['panes'],()=>Promise<readonly UiPane[]>>>;
 type Input=Assert<Equal<OpEventOf['ui.panes'],Record<never,never>>>;
 type Event=Assert<Equal<EventOf['ui.panes'],Record<never,never>>>;
 type Value=Assert<Equal<OpValueOf['ui.panes'],readonly UiPane[]>>;
 type Envelope={value:readonly UiPane[];deny?:undefined}|{deny:string;value?:undefined};
 type Result=Assert<Equal<ResultOf['ui.panes'],Envelope>>;type Operation=Assert<Equal<OpEventResult<'ui.panes'>,Envelope>>;
 declare const $:EngineInterface,on:On,call:EngineCall<'ui.panes'>,args:Args<'ui.panes'>;
 const publicResult:Promise<readonly UiPane[]>=$.ui.panes();const generic:Promise<Envelope>=call(args);
 on('ui.panes',async($,e,next)=>{const name:'ui.panes'=next.event;const result:Envelope=await next(e);return result});
 on('ui.panes',()=>({deny:'held'}));on('ui.panes',()=>({value:[]}));
 void[publicResult,generic];export type{Pane,Call,Input,Event,Value,Result,Operation};`)).toEqual([])
})

test('public panes has no argument, keeps a readonly list and rejects incorrect hook receipts',()=>{
 expect(diagnostics(`import type{EngineInterface,UiPane,On}from 'claude-code';declare const $:EngineInterface,on:On;
 // @ts-expect-error Public sugar has no argument.
 $.ui.panes({});
 $.ui.panes().then(panes=>{
 // @ts-expect-error The array is readonly.
 panes.push({id:'x',title:'X',isShown:true,isFocused:false,isPlaced:true});
 });
 // @ts-expect-error UiPane has no private placement/rendering fields.
 const extra:UiPane={id:'x',title:'X',isShown:true,isFocused:false,isPlaced:true,placement:'dock'};
 // @ts-expect-error No bare array receipt.
 on('ui.panes',()=>[]);
 // @ts-expect-error All five fields are required.
 on('ui.panes',()=>({value:[{id:'x',title:'X'}]}));
 // @ts-expect-error Boolean flags are not optional or strings.
 on('ui.panes',()=>({value:[{id:'x',title:'X',isShown:'yes',isFocused:false,isPlaced:true}]}));
 const pane:UiPane={id:'x',title:'X',isShown:true,isFocused:false,isPlaced:true};pane.title='not readonly in official type';void[extra,pane];`)).toEqual([])
})

test('author testing Engine does not invent a panes convenience method',()=>{
 expect(diagnostics(`import type{Engine,EngineCall}from 'claude-code/testing';declare const $:Engine,call:EngineCall<'ui.panes'>;
 // @ts-expect-error Official EventCalls/testing Engine has no panes convenience call.
 $.ui.panes({});
 call({});`)).toEqual([])
})
