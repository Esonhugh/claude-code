import { afterEach, expect, test } from 'bun:test'
import { createModsRuntime, type ModsRuntime } from './runtime.js'
import { createModRemoteUIControl } from './remoteUiControl.js'
import type { SDKControlRequest } from '../../entrypoints/sdk/controlTypes.js'

const runtimes: ModsRuntime[]=[]
afterEach(async()=>{for(const runtime of runtimes.splice(0))await runtime.dispose()})
async function fixture(){
 const diagnostics:unknown[]=[];const runtime=createModsRuntime({onDiagnostic:error=>diagnostics.push(error)});runtimes.push(runtime)
 await runtime.bind({cwd:process.cwd(),surface:null,isInteractive:false,sessionId:'remote-prompt'})
 const replies=new Map<string,unknown>();let id=0
 const control=createModRemoteUIControl({runtime:()=>runtime,success:(message,result)=>{replies.set(message.request_id,result)},error:(message,error)=>{replies.set(message.request_id,{error})}})
 function send(request:SDKControlRequest['request']){const requestId=String(++id);expect(control.handleRequest({type:'control_request',request_id:requestId,request})).toBe(true);return requestId}
 async function ask(request:SDKControlRequest['request']){const requestId=send(request);await control.settle();return replies.get(requestId)}
 return {runtime,control,replies,send,ask,diagnostics}
}

test('SDK prompt controls answer without a remote attachment, clamp UTF-16 cursor, and skip empty tokens',async()=>{
 const f=await fixture()
 expect(await f.ask({subtype:'ui_prompt_edit',text:'a😀',cursor:99})).toEqual({text:'a😀',cursor:3})
 expect(await f.ask({subtype:'ui_prompt_autocomplete',text:'hi #12',cursor:99})).toEqual({suggestions:[],start:3})
 expect(await f.ask({subtype:'ui_prompt_autocomplete',text:'hi ',cursor:3})).toEqual({suggestions:[]})
})

test('SDK app adoption raises nothing; person edit sees the adopted box and pinned key',async()=>{
 const f=await fixture();const seen:unknown[]=[]
 f.runtime.registerHostCallback({tier:'user',registration:{id:1,event:'prompt.edit',hasCatch:false}},async(_$,e,next)=>{seen.push(e);return next(e)})
 expect(await f.ask({subtype:'ui_prompt_edit',client_id:'person',by:'app',text:'a😀b',cursor:3,key:{key:'spoof'}})).toEqual({text:'a😀b',cursor:3})
 expect(seen).toEqual([])
 expect(await f.ask({subtype:'ui_prompt_edit',client_id:'person',text:'a😀Xb',cursor:4,key:{key:'X',shift:true}})).toEqual({text:'a😀Xb',cursor:4})
 expect(seen).toEqual([{origin:{kind:'composer'},text:'a😀b',cursor:3,start:3,end:3,inputText:'X',key:{key:'X',shift:true}}])
})

test('SDK autocomplete raises exact box facts and normalizes rows',async()=>{
 const f=await fixture();const seen:unknown[]=[]
 f.runtime.registerHostCallback({tier:'user',registration:{id:1,event:'prompt.autocomplete',hasCatch:false}},(_$,e)=>{seen.push(e);return {suggestions:[{text:'#123',label:'  One\n Two ',description:'detail'},{text:'\u200B'},{text:'#456',label:''}]}})
 expect(await f.ask({subtype:'ui_prompt_autocomplete',text:'ask #12suffix',cursor:7})).toEqual({suggestions:[{text:'#123',label:'One Two',description:'detail'},{text:'#456'}],start:4})
 expect(seen).toEqual([{text:'ask #12suffix',cursor:7,token:'#12',start:4}])
})

test('SDK overlapping edits raise latest once, omit a folded key, and keep replies after control cancellation',async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();const seen:unknown[]=[]
 f.runtime.registerHostCallback({tier:'user',registration:{id:1,event:'prompt.edit',hasCatch:false}},async(_$,e,next)=>{seen.push(e);if(seen.length===1){entered.resolve();await release.promise}return next(e)})
 const first=f.send({subtype:'ui_prompt_edit',client_id:'a',text:'a',cursor:1,key:{key:'a'}});await entered.promise
 const middle=f.send({subtype:'ui_prompt_edit',client_id:'a',text:'ab',cursor:2,key:{key:'b'}})
 const last=f.send({subtype:'ui_prompt_edit',client_id:'a',text:'abc',cursor:3,key:{key:'c'}})
 f.control.cancel(first);release.resolve();await f.control.settle()
 expect(f.replies.get(first)).toEqual({text:'a',cursor:1})
 expect(f.replies.get(middle)).toEqual({text:'ab',cursor:2,superseded:true})
 expect(f.replies.get(last)).toEqual({text:'abc',cursor:3})
 expect(seen).toEqual([{origin:{kind:'composer'},key:{key:'a'},text:'',cursor:0,start:0,end:0,inputText:'a'},{origin:{kind:'composer'},text:'a',cursor:1,start:1,end:1,inputText:'bc'}])
})

test('SDK autocomplete cancels an overtaken active ask and drops all but the newest pending ask',async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>();const seen:unknown[]=[]
 f.runtime.registerHostCallback({tier:'user',registration:{id:1,event:'prompt.autocomplete',hasCatch:false}},async(_$,e,next)=>{seen.push(e);if(seen.length===1){entered.resolve();await new Promise((_resolve,reject)=>next.signal.addEventListener('abort',()=>reject(next.signal.reason),{once:true}))}return {suggestions:[{text:String(e.token)+'!'}]}})
 const first=f.send({subtype:'ui_prompt_autocomplete',client_id:'a',text:'#1',cursor:2});await entered.promise
 const middle=f.send({subtype:'ui_prompt_autocomplete',client_id:'a',text:'#12',cursor:3})
 const last=f.send({subtype:'ui_prompt_autocomplete',client_id:'a',text:'#123',cursor:4})
 await f.control.settle()
 expect(f.replies.get(first)).toEqual({suggestions:[],superseded:true})
 expect(f.replies.get(middle)).toEqual({suggestions:[],superseded:true})
 expect(f.replies.get(last)).toEqual({suggestions:[{text:'#123!'}],start:0})
 expect(seen).toHaveLength(2)
})

test('real Worker prompt middleware edits UTF-16 drafts, carries valid decorations and enforces readonly autocomplete facts', async () => {
 const {mkdtemp,realpath,writeFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path')
 const root=await realpath(await mkdtemp(join(tmpdir(),'mods-remote-prompt-worker-'))),f=await fixture();const diagnostics=f.diagnostics
 try {
  const entry=join(root,'owner.ts')
  await writeFile(entry,`export function register(on){
   on('prompt.edit',async($,e,next)=>{const result=await next(e);return {...result,text:result.text+'!',cursor:result.cursor+1,decorations:[{start:0,end:1,bold:true}]}});
   on('prompt.autocomplete',async($,e,next)=>{if(e.token==='bad')return next({...e,token:'spoof'});if(e.token==='invalid')return {suggestions:[{text:42}]};if(e.token==='empty')return {suggestions:[{text:'valid'},{text:''}]};return {suggestions:[{text:e.token+'!',label:' worker\\n row '}]}});
  }`)
  await f.runtime.reconcile([{name:'worker',storageId:'worker@local',pluginRoot:root,entrypoints:[entry]}])
  expect(await f.ask({subtype:'ui_prompt_edit',text:'😀',cursor:2})).toEqual({text:'😀!',cursor:3})
  expect(await f.ask({subtype:'ui_prompt_edit',text:'a',cursor:1})).toEqual({text:'a!',cursor:2,decorations:[{start:0,end:1,bold:true}]})
  expect(await f.ask({subtype:'ui_prompt_autocomplete',text:'hi 😀',cursor:5})).toEqual({suggestions:[{text:'😀!',label:'worker row'}],start:3})
  expect(await f.ask({subtype:'ui_prompt_autocomplete',text:'bad',cursor:3})).toEqual({suggestions:[],start:0})
  expect(await f.ask({subtype:'ui_prompt_autocomplete',text:'invalid',cursor:7})).toEqual({suggestions:[],start:0})
  expect(await f.ask({subtype:'ui_prompt_autocomplete',text:'empty',cursor:5})).toEqual({suggestions:[],start:0})
  expect(diagnostics).toHaveLength(3)
 } finally {await f.control.dispose();await f.runtime.dispose();await rm(root,{recursive:true,force:true})}
})

test('offered rewrites become the closest baseline; app adoption in flight prevents adopting its stale offer',async()=>{
 const f=await fixture();const seen:any[]=[]
 f.runtime.registerHostCallback({tier:'user',registration:{id:1,event:'prompt.edit',hasCatch:false}},async(_$,e,next)=>{seen.push(e);const result=await next(e) as any;return {...result,text:result.text+'!',cursor:result.cursor+1}})
 expect(await f.ask({subtype:'ui_prompt_edit',text:'a',cursor:1})).toEqual({text:'a!',cursor:2})
 expect(await f.ask({subtype:'ui_prompt_edit',text:'a!b',cursor:3})).toEqual({text:'a!b!',cursor:4})
 expect(seen[1]).toMatchObject({text:'a!',cursor:2,start:2,end:2,inputText:'b'})
 const gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>()
 f.runtime.registerHostCallback({tier:'prepend',registration:{id:2,event:'prompt.edit',hasCatch:false}},async(_$,e,next)=>{entered.resolve();await gate.promise;return next(e)})
 const first=f.send({subtype:'ui_prompt_edit',client_id:'other',text:'x',cursor:1});await entered.promise
 const adopt=f.send({subtype:'ui_prompt_edit',client_id:'other',by:'app',text:'new',cursor:3});gate.resolve();await f.control.settle()
 expect(f.replies.get(first)).toEqual({text:'x!',cursor:2});expect(f.replies.get(adopt)).toEqual({text:'new',cursor:3})
 await f.ask({subtype:'ui_prompt_edit',client_id:'other',text:'newX',cursor:4})
 expect(seen.at(-1)).toMatchObject({text:'new',cursor:3,start:3,end:3,inputText:'X'})
 await f.control.dispose()
})

test('detach aborts current completion, settles pending callers and resets the client draft',async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>();const seen:any[]=[]
 f.runtime.registerHostCallback({tier:'user',registration:{id:1,event:'prompt.autocomplete',hasCatch:false}},async(_$,e,next)=>{entered.resolve();await new Promise((_resolve,reject)=>next.signal.addEventListener('abort',()=>reject(next.signal.reason),{once:true}));return {suggestions:[]}})
 f.runtime.registerHostCallback({tier:'user',registration:{id:2,event:'prompt.edit',hasCatch:false}},async(_$,e,next)=>{seen.push(e);return next(e)})
 await f.ask({subtype:'ui_attach',surface:'desktop',client_id:'reader'})
 await f.ask({subtype:'ui_prompt_edit',client_id:'reader',by:'app',text:'old',cursor:3})
 const first=f.send({subtype:'ui_prompt_autocomplete',client_id:'reader',text:'#1',cursor:2});await entered.promise
 const pending=f.send({subtype:'ui_prompt_autocomplete',client_id:'reader',text:'#12',cursor:3})
 f.send({subtype:'ui_detach',client_id:'reader'});await f.control.settle()
 expect(f.replies.get(first)).toEqual({suggestions:[],superseded:true});expect(f.replies.get(pending)).toEqual({suggestions:[],superseded:true})
 await f.ask({subtype:'ui_prompt_edit',client_id:'reader',text:'new',cursor:3})
 expect(seen.at(-1)).toMatchObject({text:'',cursor:0,start:0,end:0,inputText:'new'});await f.control.dispose()
})
