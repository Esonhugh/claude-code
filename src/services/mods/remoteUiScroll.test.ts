import {afterEach,beforeEach,expect,test} from 'bun:test'
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createModsRuntime,type ModsRuntime} from './runtime.js'
import {createModRemoteUIControl} from './remoteUiControl.js'
import {SDKMessageSchema} from '../../entrypoints/sdk/coreSchemas.js'
import type {SDKControlRequest} from '../../entrypoints/sdk/controlTypes.js'

let root:string
const runtimes:ModsRuntime[]=[]
beforeEach(async()=>{root=await realpath(await mkdtemp(join(tmpdir(),'mods-remote-scroll-')))})
afterEach(async()=>{await Promise.all(runtimes.splice(0).map(r=>r.dispose()));await rm(root,{recursive:true,force:true})})
async function fixture(){
 const diagnostics:unknown[]=[],events:any[]=[],messages:any[]=[],replies:any[]=[],panes:any[]=[],trace:any[]=[]
 const runtime=createModsRuntime({onDiagnostic:e=>diagnostics.push(e)});runtimes.push(runtime)
 await runtime.bind({cwd:root,sessionId:'scroll',surface:null,isInteractive:false})
 const entry=join(root,'owner.ts')
 await writeFile(entry,`export function register(on){
 on('session.start',async($,e,next)=>{await $.ui.open({id:'alpha'});return next(e)});
 on('tool.call',async($,e)=>({result:e.input.action==='open'?await $.ui.open({id:'alpha'}):await $.ui.scroll(e.input)}));
 on('ui.scroll',async($,e,next)=>{if(e.by===50)return {deny:'keep it'};if(e.by===51)throw Error('scroll failure');if(e.by===52)return next({offset:2});if(e.by===53)return next({...e,by:0});if(e.by===54)await $.ui.scroll({to:'end',in:e.requestId});if(e.by===55)await $.clock.sleep(80);return next(e)});
 on('ui.render',{component:'AbovePrompt'},($,e)=>$.ui.resolve(e).Text({},'above'));
 }`)
 await runtime.reconcile([{name:'owner',storageId:'owner@local',pluginRoot:root,entrypoints:[entry]}])
 runtime.registerHostCallback({tier:'prepend',registration:{id:9,event:'ui.scroll',hasCatch:false}},async(_$,e,next)=>{events.push(structuredClone(e));return next(e)})
 const control=createModRemoteUIControl({runtime:()=>runtime,scroll:m=>messages.push(m),panes:m=>{panes.push(m);trace.push('panes')},success:(m,r)=>{replies.push({id:m.request_id,response:r});trace.push('reply')},error:(m,error)=>replies.push({id:m.request_id,error})})
 let id=0
 const start=(request:SDKControlRequest['request'])=>{const request_id=String(++id);expect(control.handleRequest({type:'control_request',request_id,request})).toBe(true);return request_id}
 const send=async(request:SDKControlRequest['request'])=>{const key=start(request);await control.settle();return replies.find(r=>r.id===key)}
 const scroll=(changes:Record<string,unknown>={})=>send({subtype:'ui_scroll',component:'Pane',instance_id:'alpha',client_id:'reader',offset:3,by:2,body_rows:4,content_rows:30,...changes} as any)
 const render=(changes:Record<string,unknown>={})=>send({subtype:'ui_render',surface:'desktop',component:'Pane',instance_id:'alpha',client_id:'reader',props:{scroll:{offset:3,bodyRows:4}},content_rows:30,...changes} as any)
 const author=async(input:Record<string,unknown>)=>(await runtime.dispatch('tool.call',{tool:'owned',input},async()=>({result:null})) as any).result
 await send({subtype:'ui_attach',surface:'desktop',client_id:'reader'})
 return {runtime,control,events,messages,replies,panes,trace,diagnostics,start,send,scroll,render,author}
}

test('SDK reports create scroll sites before draw; cached position ignores later reported offsets',async()=>{
 const f=await fixture();expect((await f.scroll()).response).toEqual({moved:true,offset:2})
 await f.render();expect((await f.scroll({offset:25,by:10,pointer:{column:2,row:3}})).response).toEqual({moved:true,offset:12})
 expect(f.events.at(-1)).toEqual({component:'Pane',requestId:'alpha',offset:12,by:10,bodyRows:4,contentRows:30,origin:{kind:'person'},pointer:{column:2,row:3}})
 expect((await f.scroll({offset:3,by:-20})).response).toEqual({moved:true,offset:0});expect(f.messages).toEqual([])
 await f.control.dispose()
})

test('scroll hook denial, failure fallback and readonly restoration retain the official offset rules',async()=>{
 const f=await fixture();await f.render()
 expect((await f.scroll({by:50})).response).toEqual({moved:false,offset:3,deny:'keep it'})
 expect((await f.scroll({by:51})).response).toEqual({moved:true,offset:26})
 expect((await f.scroll({by:52})).response).toEqual({moved:true,offset:2})
 expect((await f.scroll({by:53})).response).toEqual({moved:true,offset:26})
 expect(f.diagnostics).toHaveLength(2);await f.control.dispose()
})

test('author end scroll shares the SDK view, supersedes person work and pushes follow-end state',async()=>{
 const f=await fixture();await f.render()
 expect((await f.scroll({by:54})).response).toEqual({moved:false,offset:26,deny:'the window moved meanwhile',follow_end:true})
 expect(f.messages).toEqual([{type:'system',subtype:'ui_scroll',client_id:'reader',component:'Pane',instance_id:'alpha',offset:26},{type:'system',subtype:'ui_scroll',client_id:'reader',component:'Pane',instance_id:'alpha',offset:26,follow_end:true}])
 for(const m of f.messages)expect(SDKMessageSchema().parse({...m,uuid:'owned',session_id:'scroll'})).toEqual({...m,uuid:'owned',session_id:'scroll'})
 expect((await f.scroll({offset:0,by:1,content_rows:34})).response).toEqual({moved:true,offset:30,follow_end:true})
 expect((await f.scroll({offset:30,by:-1,content_rows:34})).response).toEqual({moved:true,offset:29})
 await f.control.dispose()
})

test('queued scrolling sums deltas, uses latest metrics and survives control cancellation',async()=>{
 const f=await fixture();await f.render()
 const request={subtype:'ui_scroll',component:'Pane',instance_id:'alpha',client_id:'reader',offset:0,body_rows:4,content_rows:30} as const
 const first=f.start({...request,by:55});
 await new Promise<void>(resolve=>{const check=()=>f.events.length?resolve():setTimeout(check,1);check()})
 const a=f.start({...request,by:-2,offset:22});const b=f.start({...request,by:-3,offset:17});f.control.cancel(first);await f.control.settle()
 expect(f.replies.find(r=>r.id===first).response).toEqual({moved:true,offset:26})
 expect(f.replies.find(r=>r.id===a).response).toEqual({moved:true,offset:21});expect(f.replies.find(r=>r.id===b).response).toEqual({moved:true,offset:21})
 expect(f.events.map(e=>e.by)).toEqual([55,-5]);await f.control.dispose()
})

test('AbovePrompt requires its canonical ID; existing views accept another reporting client',async()=>{
 const f=await fixture();expect((await f.scroll({instance_id:'missing'})).response).toEqual({moved:false,offset:3,deny:'no such site'})
 expect((await f.scroll({component:'AbovePrompt',instance_id:'another'})).response).toEqual({moved:false,offset:3,deny:'no such site'})
 expect((await f.scroll({component:'AbovePrompt',instance_id:'above-prompt'})).response).toEqual({moved:true,offset:2})
 await f.render();expect((await f.scroll({client_id:'stranger'})).response).toEqual({moved:true,offset:5})
 await f.send({subtype:'ui_detach',client_id:'reader'});expect((await f.scroll()).response).toEqual({moved:false,offset:3,deny:'no such site'})
 await f.control.dispose()
})

test('closing a Pane removes its view and pending reports cannot commit into the replacement',async()=>{
 const f=await fixture();await f.render()
 const first=f.start({subtype:'ui_scroll',component:'Pane',instance_id:'alpha',client_id:'reader',offset:0,by:55,body_rows:4,content_rows:30})
 await new Promise<void>(resolve=>{const check=()=>f.events.length?resolve():setTimeout(check,1);check()})
 await f.runtime.ui.closePane('alpha');await f.author({action:'open'});await f.render({props:{scroll:{offset:1,bodyRows:4}}});await f.control.settle()
 expect(f.replies.find(r=>r.id===first).response).toEqual({moved:false,offset:3,deny:'no such site'})
 expect((await f.scroll({by:1})).response).toEqual({moved:true,offset:2});await f.control.dispose()
})

test('author key alignment is owner-filtered and sends updates to the latest rendering client',async()=>{
 const f=await fixture();await f.render({keyed:[{plugin:'owner',key:'item',top:12,bottom:14},{plugin:'peer',key:'foreign',top:20,bottom:22}]})
 expect(await f.author({to:{key:'item'},in:'alpha',block:'center'})).toEqual({})
 expect(f.messages.at(-1)).toMatchObject({client_id:'reader',offset:11})
 expect(await f.author({to:{key:'foreign'},in:'alpha'})).toEqual({deny:'no element of its own is drawn under that key'})
 await f.render({client_id:'reader-two',props:{scroll:{offset:0,bodyRows:4}}});expect(await f.author({to:'start',in:'alpha'})).toEqual({})
 expect(f.messages.at(-1)).toMatchObject({client_id:'reader-two',offset:0});await f.control.dispose()
})

test('malformed scroll reports are errors, distinct from valid reports with denied moves',async()=>{
 const f=await fixture();expect((await f.scroll({by:1.2})).error).toContain('by an integer')
 expect((await f.scroll({keyed:Array(513).fill({plugin:'p',key:'k',top:0,bottom:1})})).error).toContain('at most 512')
 await f.control.dispose()
})


test('author AbovePrompt eligibility and explicit owner site guards apply to remote scrolling',async()=>{
 const f=await fixture();await f.render({component:'AbovePrompt',instance_id:'above-prompt',props:{scroll:{offset:1,bodyRows:3}},content_rows:12})
 expect(await f.author({to:'end',in:'above-prompt'})).toEqual({})
 expect(f.messages.at(-1)).toMatchObject({component:'AbovePrompt',instance_id:'above-prompt',offset:9,follow_end:true})
 expect(await f.author({to:'start',in:'missing'})).toEqual({deny:"not this plugin's site"})
 await f.control.dispose()
})


test('layout attachment sends a roster catch-up after its reply, without duplicating placement changes',async()=>{
 const f=await fixture();f.trace.length=0
 await f.send({subtype:'ui_attach',surface:'desktop',client_id:'reader',viewport:{columns:80,rows:24,isFullscreen:false}})
 expect(f.trace).toEqual(['reply','panes']);expect(f.panes).toHaveLength(1)
 f.trace.length=0;await f.send({subtype:'ui_attach',surface:'desktop',client_id:'reader'})
 expect(f.trace).toEqual(['reply','panes']);expect(f.panes).toHaveLength(2)
 await f.control.dispose()
})

test('normal session end removes remote views before detach/end observers can use them',async()=>{
 const f=await fixture();await f.render({component:'AbovePrompt',instance_id:'above-prompt',props:{scroll:{offset:7,bodyRows:3}},content_rows:12})
 let detached:unknown
 f.runtime.registerHostCallback({tier:'prepend',registration:{id:10,event:'session.detach',hasCatch:false}},async(_$,e,next)=>{if(e.clientId==='reader')detached=await f.runtime.remoteScroll.report({subtype:'ui_scroll',component:'AbovePrompt',instance_id:'above-prompt',client_id:'reader',offset:3,by:2,body_rows:3,content_rows:12});return next(e)})
 await f.runtime.endSession('clear')
 expect(detached).toEqual({moved:false,offset:3,deny:'no such site'})
 expect((await f.scroll({component:'AbovePrompt',instance_id:'above-prompt'})).response).toEqual({moved:false,offset:3,deny:'no such site'})
 expect(await f.author({to:'end',in:'above-prompt'})).toEqual({deny:"not this plugin's site"});await f.control.dispose()
})
