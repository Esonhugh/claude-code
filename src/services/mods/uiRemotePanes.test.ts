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
beforeEach(async()=>{root=await realpath(await mkdtemp(join(tmpdir(),'mods-remote-panes-')))})
afterEach(async()=>{await Promise.all(runtimes.splice(0).map(r=>r.dispose()));await rm(root,{recursive:true,force:true})})
async function fixture(){
 const diagnostics:unknown[]=[],notifications:any[]=[],replies:any[]=[],draws:unknown[]=[]
 const runtime=createModsRuntime({onDiagnostic:e=>diagnostics.push(e)});runtimes.push(runtime)
 await runtime.bind({cwd:root,sessionId:'panes',surface:null,isInteractive:false})
 const entry=join(root,'owner.ts')
 await writeFile(entry,`export function register(on){
 on('tool.call',async($,e)=>{const result=e.input.action==='close'?await $.ui.close({id:e.input.id}):await $.ui.open(e.input);return {result:{result,panes:await $.ui.panes()}}});
 on('ui.close',async($,e,next)=>{if(e.id==='kept')return {deny:'keep it'};if(e.id==='broken')throw Error('broken close');if(e.id==='redirect')return next({...e,id:'beta'});if(e.id==='held')await $.clock.sleep(80);return next(e)});
 on('ui.render',{component:'Pane'},($,e)=>$.ui.resolve(e).Text({},'pane'));
 }`)
 await runtime.reconcile([{name:'owner',storageId:'owner@local',pluginRoot:root,entrypoints:[entry]}])
 runtime.registerHostCallback({tier:'prepend',registration:{id:9,event:'ui.render',hasCatch:false}},async(_$,e,next)=>{draws.push(e);return next(e)})
 const control=createModRemoteUIControl({runtime:()=>runtime,panes:m=>notifications.push(m),success:(m,r)=>replies.push({id:m.request_id,response:r}),error:(m,error)=>replies.push({id:m.request_id,error})})
 let id=0
 const start=(request:SDKControlRequest['request'])=>{const request_id=String(++id);expect(control.handleRequest({type:'control_request',request_id,request})).toBe(true);return request_id}
 const send=async(request:SDKControlRequest['request'])=>{const key=start(request);await control.settle();return replies.find(r=>r.id===key)}
 const open=async(input:Record<string,unknown>)=>(await runtime.dispatch('tool.call',{tool:'owned',input},async()=>({result:null})) as any).result
 const state=async()=> (await send({subtype:'ui_panes'})).response
 return {runtime,control,open,state,send,start,replies,notifications,diagnostics,draws,entry}
}

test('headless panes use canonical records without terminal draws, and expose finite SDK state',async()=>{
 const f=await fixture();expect(await f.state()).toEqual({panes:[],shown_id:null,focused_id:null,focus_requested_id:null})
 const result=await f.open({id:'alpha',title:'Alpha',focus:true,closeOnEscape:true,holdToasts:true,rows:7,columns:33})
 expect(result).toEqual({result:{isPlaced:true},panes:[{id:'alpha',title:'Alpha',isShown:true,isFocused:false,isPlaced:true}]})
 expect(await f.state()).toEqual({panes:[{id:'alpha',title:'Alpha',plugin:'owner',close_on_escape:true,hold_toasts:true,rows:7,columns:33}],shown_id:'alpha',focused_id:null,focus_requested_id:'alpha'})
 expect(f.draws).toEqual([]);expect(f.diagnostics).toEqual([])
 expect(f.notifications).toEqual([{type:'system',subtype:'ui_panes',...(await f.state())}])
 const message={...f.notifications[0],uuid:'owned',session_id:'panes'}
 expect(SDKMessageSchema().parse(message)).toEqual(message)
 expect(SDKMessageSchema().safeParse({...message,panes:[{id:'a',title:'a',plugin:'owner',close_on_escape:false}]}).success).toBe(false)
 await f.control.dispose()
})

test('show and focus follow official unknown-id, null, held focus and request clearing rules',async()=>{
 const f=await fixture();await f.state();await f.open({id:'alpha',focus:true})
 const n=f.notifications.length
 expect((await f.send({subtype:'ui_pane_show',id:'missing'})).response).toEqual({shown_id:'alpha'});expect(f.notifications).toHaveLength(n)
 expect((await f.send({subtype:'ui_pane_focus',id:'missing'})).response).toEqual({focused_id:null});expect((await f.state()).focus_requested_id).toBeNull()
 expect((await f.send({subtype:'ui_pane_focus',id:'alpha',surface:'vscode',client_id:'x'})).response).toEqual({focused_id:'alpha'})
 await f.open({id:'beta'});expect(await f.state()).toMatchObject({shown_id:'alpha',focused_id:'alpha'})
 expect((await f.send({subtype:'ui_pane_show',id:'beta'})).response).toEqual({shown_id:'beta'});expect((await f.state()).focused_id).toBe('beta')
 await f.send({subtype:'ui_pane_focus',id:null});await f.send({subtype:'ui_pane_show',id:'alpha'})
 expect(await f.state()).toMatchObject({shown_id:'alpha',focused_id:null})
 await f.control.dispose()
})

test('remote viewport placement includes false fullscreen, promotes waiting panes and never retracts placed ones',async()=>{
 const f=await fixture();await f.state();await f.send({subtype:'ui_attach',surface:'mobile',client_id:'no-layout',viewport:{columns:80,rows:24}})
 expect(await f.open({id:'waiting',focus:true})).toEqual({result:{isPlaced:false,reason:'no attached surface places panes (no-layout): placed when a surface that does attaches, or once they detach'},panes:[{id:'waiting',title:'waiting',isShown:false,isFocused:false,isPlaced:false}]})
 expect((await f.state()).panes).toEqual([]);expect(f.notifications).toEqual([])
 await f.send({subtype:'ui_pane_show',id:'waiting'});await f.send({subtype:'ui_pane_focus',id:'waiting'});expect(await f.state()).toMatchObject({shown_id:null,focused_id:null,focus_requested_id:null})
 await f.send({subtype:'ui_attach',surface:'vscode',client_id:'placer',viewport:{columns:80,rows:24,isFullscreen:false}})
 expect(await f.state()).toMatchObject({panes:[{id:'waiting',title:'waiting',plugin:'owner'}],shown_id:'waiting',focus_requested_id:null})
 await f.send({subtype:'ui_detach',client_id:'placer'});expect((await f.state()).panes).toHaveLength(1)
 expect((await f.open({id:'second'})).result.isPlaced).toBe(false)
 await f.send({subtype:'ui_detach',client_id:'no-layout'});expect(await f.state()).toMatchObject({shown_id:'second',panes:[{id:'waiting',title:'waiting',plugin:'owner'},{id:'second',title:'second',plugin:'owner'}]})
 await f.control.dispose()
})

test('cross-plugin same-id updates keep original attribution and omit replaced manners; peer closes original',async()=>{
 const f=await fixture();await f.state();await f.open({id:'beta',rows:7,holdToasts:true})
 const peer=join(root,'peer.ts');await writeFile(peer,`export function register(on){on('tool.call',{tool:'peer'},async($,e)=>{if(e.input.action==='close')await $.ui.close({id:'beta'});else await $.ui.open({id:'beta',title:'Peer beta'});return {result:await $.ui.panes()}})}`)
 await f.runtime.reconcile([{name:'owner',storageId:'owner@local',pluginRoot:root,entrypoints:[f.entry]},{name:'peer',storageId:'peer@local',pluginRoot:root,entrypoints:[peer],tier:'prepend'}])
 expect(await f.runtime.dispatch('tool.call',{tool:'peer',input:{}},async()=>({result:null}))).toEqual({result:[]})
 expect((await f.state()).panes).toEqual([{id:'beta',title:'Peer beta',plugin:'owner'}])
 const closes:unknown[]=[];f.runtime.registerHostCallback({tier:'prepend',registration:{id:12,event:'ui.close',hasCatch:false}},async(_$,e,next)=>{closes.push(e);return next(e)})
 await f.runtime.dispatch('tool.call',{tool:'peer',input:{action:'close'}},async()=>({result:null}));expect((await f.state()).panes).toEqual([]);expect(closes).toEqual([{id:'beta',origin:{kind:'plugin'}}])
 await f.control.dispose()
})

test('close denies keep panes, throws and invalid rewrites fall back to original, absent closes are true',async()=>{
 const f=await fixture();await f.state();for(const id of ['beta','kept','broken','redirect'])await f.open({id})
 expect((await f.send({subtype:'ui_close',id:'kept'})).response).toEqual({closed:false})
 expect((await f.send({subtype:'ui_close',id:'broken'})).response).toEqual({closed:true})
 expect((await f.send({subtype:'ui_close',id:'redirect'})).response).toEqual({closed:true})
 expect(await f.state()).toMatchObject({shown_id:'kept',panes:[{id:'beta',title:'beta',plugin:'owner'},{id:'kept',title:'kept',plugin:'owner'}]})
 expect((await f.send({subtype:'ui_close',id:'missing'})).response).toEqual({closed:true})
 await f.control.dispose()
})

test('duplicate closing does not call hooks again and cancellation does not abandon pane controls',async()=>{
 const f=await fixture();await f.state();await f.open({id:'held',focus:true});let calls=0
 f.runtime.registerHostCallback({tier:'prepend',registration:{id:10,event:'ui.close',hasCatch:false}},async(_$,e,next)=>{calls++;return next(e)})
 const key=f.start({subtype:'ui_close',id:'held'});await Bun.sleep(20);f.control.cancel(key)
 const duplicate=f.start({subtype:'ui_close',id:'held'});await f.control.settle()
 expect(f.replies.find(r=>r.id===duplicate)?.response).toEqual({closed:false});expect(f.replies.find(r=>r.id===key)?.response).toEqual({closed:true});expect(calls).toBe(1)
 expect(await f.state()).toEqual({panes:[],shown_id:null,focused_id:null,focus_requested_id:null})
 await f.control.dispose()
})

test('titles permit newlines, tabs and valid surrogate pairs but reject escape, lone surrogate and placeholder',async()=>{
 const f=await fixture();await f.state();for(const title of ['bad\nline','tab\tline','return\rline','emoji 😀'])expect((await f.open({id:'title',title})).result).toEqual({isPlaced:true})
 for(const title of ['escape\x1bline','bad\ud800','bad\u{10eeee}']){const before=await f.state();await f.open({id:'title',title});expect(await f.state()).toEqual(before)}
 expect(f.diagnostics.length).toBeGreaterThanOrEqual(3);await f.control.dispose()
})

test('four controls validate finite protocol and use official malformed error strings',async()=>{
 const f=await fixture()
 for(const [request,error] of [
 [{subtype:'ui_panes',client_id:'bad:id'},'ui_panes: client_id (when given) 1-64 safe characters'],
 [{subtype:'ui_pane_show',id:'bad id'},'ui_pane_show: id must be 1-64 of letters, digits, _ or -'],
 [{subtype:'ui_pane_focus',id:2},'ui_pane_focus: id must be null or 1-64 of letters, digits, _ or -, surface (when given) "desktop", "mobile" or "vscode"'],
 [{subtype:'ui_close',id:''},'ui_close: id must be 1-64 of letters, digits, _ or -']
 ] as const)expect((await f.send(request as any)).error).toBe(error)
 await f.control.dispose()
})


test('registration metadata survives headless commit, gets an initial SDK push and closes on unload',async()=>{
 const f=await fixture();await writeFile(f.entry,`export function register(on){on('session.start',async($,e,next)=>{await $.ui.open({id:'boot',focus:true});if((await $.ui.panes())[0]?.isShown!==true)throw Error('boot should already be shown');return next(e)})}`)
 await f.runtime.reconcile([{name:'owner',storageId:'owner@local',pluginRoot:root,entrypoints:[f.entry]}])
 f.control.connect();expect(f.notifications).toEqual([{type:'system',subtype:'ui_panes',panes:[{id:'boot',title:'boot',plugin:'owner'}],shown_id:'boot',focused_id:null,focus_requested_id:'boot'}])
 f.control.connect();expect(f.notifications).toHaveLength(1)
 await f.runtime.reconcile([]);expect(f.notifications.at(-1)).toEqual({type:'system',subtype:'ui_panes',panes:[],shown_id:null,focused_id:null,focus_requested_id:null})
 await f.control.dispose()
})

test('closing a pane retires its external callback leases',async()=>{
 const f=await fixture();await f.state();await writeFile(f.entry,`export function register(on){on('session.start',async($,e,next)=>{await $.ui.open({id:'boot'});return next(e)});on('ui.render',{component:'Pane'},($,e)=>$.ui.resolve(e).Button({key:'run',label:'Run',onPress:()=>{}}))}`)
 await f.runtime.reconcile([{name:'owner',storageId:'owner@local',pluginRoot:root,entrypoints:[f.entry]}])
 const rendered=(await f.send({subtype:'ui_render',surface:'desktop',component:'Pane',instance_id:'boot',props:{}})).response
 expect(rendered.tree.type).toBe('Button');const press={subtype:'ui_press',surface:'desktop',plugin:'owner',handle:rendered.tree.press.handle,key:'run'} as const
 expect((await f.send(press)).response).toMatchObject({handled:true})
 await f.send({subtype:'ui_close',id:'boot'});expect((await f.send(press)).response).toEqual({handled:false})
 await f.control.dispose()
})
