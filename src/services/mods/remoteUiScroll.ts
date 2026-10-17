import {isDeepStrictEqual} from 'node:util'
import {logForDebugging} from '../../utils/debug.js'
import type {SDKControlUIScrollRequest,SDKControlUIScrollResponse,SDKControlUIRenderRequest,SDKUIScrollMessage,SDKUIKeyedRows,SDKUIScrollComponent} from '../../entrypoints/sdk/modsControlTypes.js'
import type {ModInput,ModOrigin} from './types.js'

/** A view is shared by navigation reports and author calls, independently of drawing leases. */
type View = {
 component:SDKUIScrollComponent
 id:string
 clientId:string
 offset:number
 bodyRows:number
 contentRows:number
 keyed:SDKUIKeyedRows[]
 following:boolean
 moving:boolean
 superseded:boolean
 queue:ReturnType<typeof coalesce<SDKControlUIScrollRequest,SDKControlUIScrollResponse>>
}

/** One running report and one pending aggregate. Every pending caller receives that aggregate's result. */
function coalesce<I,O>(merge:(a:I,b:I)=>I,work:(input:I)=>Promise<O>){
 let running=false
 let active:Promise<O>|undefined
 let pending:{input:I;promise:Promise<O>;resolve:(value:O)=>void;reject:(error:unknown)=>void}|undefined
 const run=async(input:I):Promise<O>=>{
  running=true
  try{return await work(input)}
  finally{const next=pending;pending=undefined;if(next)void start(next.input).then(next.resolve,next.reject);else running=false}
 }
 const start=(input:I)=>{const promise=run(input);active=promise;return promise}
 return {
  take(input:I):Promise<O>{
   if(!running)return start(input)
   if(pending){pending.input=merge(pending.input,input);return pending.promise}
   let resolve!:(value:O)=>void,reject!:(error:unknown)=>void
   const promise=new Promise<O>((a,b)=>{resolve=a;reject=b})
   pending={input,promise,resolve,reject};return promise
  },
  drop(value:O):void{const next=pending;pending=undefined;if(next)void active?.then(()=>next.resolve(value),()=>next.resolve(value))},
 }
}
const protectedFields=['component','requestId','by','bodyRows','contentRows','origin','pointer'] as const
export function createModRemoteScroll(options:{
 panes():readonly {id:string;plugin:string}[]
 attached(clientId:string):boolean
 dispatch(input:ModInput,core:(input:ModInput)=>Promise<unknown>,origin:ModOrigin|undefined,contract:{validateInput(input:ModInput,received:ModInput):void;restoreInput(input:ModInput,received:ModInput):ModInput}):Promise<unknown>
}){
 const views=new Map<string,View>(),listeners=new Set<(message:Omit<SDKUIScrollMessage,'uuid'|'session_id'>)=>void>()
 const keyOf=(component:string,id:string)=>`${component}:${id}`
 const valid=(component:SDKUIScrollComponent,id:string)=>component==='AbovePrompt'?id==='above-prompt':options.panes().some(p=>p.id===id)
 const max=(view:View)=>Math.max(0,view.contentRows-view.bodyRows)
 const position=(view:View)=>view.following?max(view):view.offset
 const clamp=(view:View,value:number)=>Math.max(0,Math.min(max(view),value))
 const emit=(view:View,follow=false)=>{
  const message:Omit<SDKUIScrollMessage,'uuid'|'session_id'>={type:'system',subtype:'ui_scroll',client_id:view.clientId,component:view.component,instance_id:view.id,offset:view.offset,...(follow?{follow_end:true}:{})}
  for(const listener of listeners)listener(message)
 }
 const current=(view:View)=>views.get(keyOf(view.component,view.id))===view&&valid(view.component,view.id)
 const denied=(offset:number,deny:string,following=false):SDKControlUIScrollResponse=>({moved:false,offset,deny,...(following?{follow_end:true}:{})})
 const contract={
  restoreInput(input:ModInput,received:ModInput){const result={...input};for(const key of protectedFields)if(!Object.hasOwn(result,key)&&Object.hasOwn(received,key))result[key]=received[key];return result},
  validateInput(input:ModInput,received:ModInput){
   for(const key of protectedFields)if(Object.hasOwn(input,key)&&!isDeepStrictEqual(input[key],received[key]))throw new TypeError(`Mod UI scroll cannot rewrite ${key}`)
   if(!Number.isInteger(input.offset)||(input.offset as number)<0)throw new TypeError('Mod UI scroll offset must be a non-negative whole row')
  },
 }
 async function move(view:View,offset:number,by:number,origin:{kind:'person'}|{kind:'plugin';name:string},pointer?:{column:number;row:number},hookOrigin?:ModOrigin){
  const input:ModInput={component:view.component,requestId:view.id,offset,by,bodyRows:view.bodyRows,contentRows:view.contentRows,origin,...(pointer?{pointer}:{})}
  const result=await options.dispatch(input,async next=>{
   if(!current(view))return {deny:'no such site'}
   const actor=next.origin as typeof origin
   const owner=view.component==='Pane'?options.panes().find(p=>p.id===view.id)?.plugin:undefined
   if(actor.kind==='plugin'&&owner!==undefined&&owner!==actor.name)return {deny:"not this plugin's site"}
   if(actor.kind==='person'&&view.superseded)return {deny:'the window moved meanwhile'}
   view.offset=clamp(view,next.offset as number)
   if(actor.kind==='plugin'){view.superseded=view.moving;view.following=false;emit(view)}
   else if(view.following&&view.offset<max(view))view.following=false
   return {}
  },hookOrigin,contract) as {deny?:string}
  logForDebugging(`[ModsUIRemote] ui.scroll component=${view.component} instance=${JSON.stringify(view.id)} client=${view.clientId} by=${by} offset=${position(view)} origin=${origin.kind}${origin.kind==='plugin'?':'+origin.name:''} deny=${JSON.stringify(result.deny)}`)
  return result
 }
 async function report(view:View,input:SDKControlUIScrollRequest):Promise<SDKControlUIScrollResponse>{
  if(!current(view))return denied(input.offset,'no such site')
  const end=Math.max(0,input.content_rows-input.body_rows)
  const before=view.following?end:Math.min(view.offset,end)
  const wasFollowing=view.following
  view.offset=before;view.bodyRows=input.body_rows;view.contentRows=input.content_rows
  if(input.keyed!==undefined)view.keyed=structuredClone(input.keyed)
  view.moving=true;view.superseded=false
  try{
   const result=await move(view,clamp(view,before+input.by),input.by,{kind:'person'},input.pointer)
   if(!current(view))return {...(result.deny?{deny:result.deny}:{}),moved:result.deny===undefined,offset:before}
   if(view.superseded){const outcome=denied(position(view),'the window moved meanwhile',view.following);view.queue.drop(outcome);return outcome}
   if(result.deny)view.offset=before
   view.following=view.following||(!result.deny&&wasFollowing&&input.by>0&&view.offset>=max(view))
   return {moved:result.deny===undefined,offset:position(view),...(result.deny?{deny:result.deny}:{}),...(view.following?{follow_end:true}:{})}
  }finally{view.moving=false;view.superseded=false}
 }
 function ensure(component:SDKUIScrollComponent,id:string,clientId:string,offset=0,bodyRows=0,contentRows=0){
  const key=keyOf(component,id);let view=views.get(key)
  if(!view){
   const created:View={component,id,clientId,offset,bodyRows,contentRows,keyed:[],following:false,moving:false,superseded:false,queue:coalesce((a,b)=>({...b,by:a.by+b.by}),input=>report(created,input))}
   views.set(key,created);view=created
  }
  return view
 }
 return {
  site(component:SDKUIScrollComponent,id:string){const view=views.get(keyOf(component,id));return view&&valid(component,id)?{clientId:view.clientId}:undefined},
  ensureSite(component:SDKUIScrollComponent,id:string,clientId:string){ensure(component,id,clientId)},
  subscribe(listener:(message:Omit<SDKUIScrollMessage,'uuid'|'session_id'>)=>void){listeners.add(listener);return()=>{listeners.delete(listener)}},
  reconcile(){for(const[key,view]of views)if(!valid(view.component,view.id)||!options.attached(view.clientId))views.delete(key)},
  observe(request:SDKControlUIRenderRequest){
   if(request.component!=='Pane'&&request.component!=='AbovePrompt'||!valid(request.component,request.instance_id))return
   const clientId=request.client_id??`${request.surface}:default`;if(!options.attached(clientId))return
   const raw=request.props.scroll as {offset?:unknown;bodyRows?:unknown}|undefined
   const scroll=raw&&Number.isInteger(raw.offset)&&Number.isInteger(raw.bodyRows)&&(raw.offset as number)>=0&&(raw.bodyRows as number)>=0?{offset:raw.offset as number,bodyRows:raw.bodyRows as number}:undefined
   const existing=views.get(keyOf(request.component,request.instance_id))
   const empty=!existing||existing.bodyRows===0&&existing.contentRows===0
   const view=ensure(request.component,request.instance_id,clientId);view.clientId=clientId
   if(scroll){if(empty)view.offset=scroll.offset;view.bodyRows=scroll.bodyRows}
   if(request.content_rows!==undefined)view.contentRows=request.content_rows
   if(request.keyed!==undefined)view.keyed=structuredClone(request.keyed)
  },
  report(request:SDKControlUIScrollRequest):Promise<SDKControlUIScrollResponse>{
   const clientId=request.client_id??`${request.surface??'desktop'}:default`
   const existing=views.get(keyOf(request.component,request.instance_id))
   if(!valid(request.component,request.instance_id)||!existing&&!options.attached(clientId))return Promise.resolve(denied(request.offset,'no such site'))
   return ensure(request.component,request.instance_id,clientId).queue.take(request)
  },
  async reveal(actor:ModOrigin,request:{requestId?:string;targetRequestId?:string;key?:string;edge?:'start'|'end';block?:'start'|'center'|'end'|'nearest'},abovePrompt:boolean):Promise<{deny?:string}>{
   if(request.targetRequestId!==undefined)return {deny:options.panes().some(p=>p.plugin===actor.plugin&&p.id===request.targetRequestId)?'nothing around that site scrolls':'transcript not scrollable here'}
   const eligible=options.panes().filter(p=>p.plugin===actor.plugin).map(p=>views.get(keyOf('Pane',p.id))).filter((v):v is View=>v!==undefined)
   const above=views.get(keyOf('AbovePrompt','above-prompt'));if(above&&abovePrompt)eligible.push(above)
   const candidates=request.requestId===undefined?eligible:eligible.filter(v=>v.id===request.requestId)
   if(request.requestId!==undefined&&!candidates.length)return {deny:"not this plugin's site"}
   const view=request.key===undefined?candidates[0]:candidates.find(v=>v.keyed.some(row=>row.plugin===actor.plugin&&row.key===request.key))
   if(!view)return {deny:request.key===undefined?"not this plugin's site":'no element of its own is drawn under that key'}
   const before=position(view),end=max(view)
   let target:number
   if(request.edge)target=request.edge==='start'?0:end
   else{
    const row=view.keyed.find(row=>row.plugin===actor.plugin&&row.key===request.key)!,height=row.bottom-row.top,block=request.block??'nearest'
    if(height>view.bodyRows||block==='start')target=row.top
    else if(block==='end')target=row.bottom-view.bodyRows
    else if(block==='center')target=row.top-Math.floor((view.bodyRows-height)/2)
    else if(row.top<before)target=row.top
    else if(row.bottom>before+view.bodyRows)target=Math.max(row.top,row.bottom-view.bodyRows)
    else target=before
   }
   const result=await move(view,clamp(view,target),clamp(view,target)-before,{kind:'plugin',name:actor.plugin},undefined,actor)
   if(!result.deny&&request.edge==='end'&&current(view)&&view.offset===Math.min(end,max(view))){view.following=true;emit(view,true)}
   return result
  },
  dispose(){views.clear();listeners.clear()},
 }
}
