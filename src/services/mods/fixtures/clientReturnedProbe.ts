// Executed in a test-only process so detached VM rejections cannot be claimed by bun:test.
import { createModEnvironmentHost } from '../environment.js'
import type { ModDeclaration } from '../types.js'
const mode=process.argv[2]!
const event=process.argv[3] ?? 'key'
const shape=process.argv[4] ?? 'promise'
const warnings:string[]=[]
const faults:{id:number;phase?:string;message:string}[]=[]
const host=createModEnvironmentHost({onError:error=>{warnings.push(error.message)}})
const declaration:ModDeclaration={name:'owner',storageId:'owner@test',pluginRoot:'/fixture',tier:'user',options:{},fingerprint:mode+event+shape,
 entrypoints:['/fixture/main.js'],events:['tool.call'],calls:[],nextTiers:[],links:[],
 clients:[{path:'/fixture/surface.js',module:'surface.js'}],
 modules:[{path:'/fixture/main.js',source:`export function register(on) {on('tool.call',()=> 'hooks alive')}`},
 {path:'/fixture/surface.js',source:`let initialized=false;let reject;let surface;let starts=0;
 function action() {
   if ('${mode}'==='bare') {surface.post({event:'${event}',bare:this===undefined});return;}
   starts++;
   if ('${mode}'==='success') return Promise.resolve({type:'Text',children:['must not draw']});
   if ('${shape}'==='getter') return {get then(){throw Error('getter failed')}};
   if ('${shape}'==='object') return {then(_ok,bad){reject=bad}};
   if ('${shape}'==='function') {const fn=()=>{};fn.then=(_ok,bad)=>{reject=bad};return fn;}
   const pending=new Promise((_ok,bad)=>{reject=bad});
   if ('${mode}'!=='detached') return pending;
 }
 export default function Surface(props,s) {
   surface=s;
   if ('${mode}'==='render-resolved') return Promise.resolve(s.elements.Text({children:'late tree'}));
   if ('${mode}'==='render-rejected') return Promise.reject(Error('returned render failed'));
   if ('${mode}'.startsWith('render-budget')) return Promise.reject({get message(){while(true) {}}});
   if(!initialized) {initialized=true;
     s.onPointer(action);
     s.onKey(function(e){if(e.key==='release'){reject?.(Error('returned failed'));return;}return action.call(this)});
     if('${event}'==='tick') s.every(1,action);
   }
   if('${event}'==='held') return s.elements.Button({key:'send',label:'Send',onPress:action});
   return s.elements.Text({children:'${mode}'==='bare'&&'${event}'==='draw'?String(this===undefined):'ready'});
 }`}],}
try {
 const environment=await host.load(declaration)
 const NativeWorker=globalThis.Worker
 const closed:boolean[]=[]
 let heldFault:(()=>void)|undefined
 let heldDelivered=false
 let heldInvalid:(()=>void)|undefined
 let invalidWarnings:number|undefined
 let oldUnloaded:string|undefined
 let liveEnvironment=environment
 globalThis.Worker=class extends NativeWorker {
  constructor(url:string|URL,options?:WorkerOptions) {
   super(url,options)
   const index=closed.push(false)-1
   this.addEventListener('close',()=>{closed[index]=true},{once:true})
   if((mode==='generation'||mode==='unloaded') && index===0) {
    const property=Object.getOwnPropertyDescriptor(NativeWorker.prototype,'onmessage')!
    Object.defineProperty(this,'onmessage',{
     get:()=>property.get!.call(this),
     set:(handler:Worker['onmessage'])=>property.set!.call(this,(event:MessageEvent)=>{
      if(event.data.type==='client-fault') {
       heldFault=()=>{handler?.call(this,event);heldDelivered=true}
       heldInvalid=()=>{
        handler?.call(this,{data:{...event.data,instance:2}} as MessageEvent)
        handler?.call(this,{data:{...event.data,environment:event.data.environment+1}} as MessageEvent)
       }
      } else handler?.call(this,event)
     }),
    })
   }
  }
 } as typeof Worker
 const onFault=(id:number,generation?:string)=>(error:Error & {phase?:string})=>{faults.push({id,phase:error.phase,message:error.message,...(generation?{generation}:{})})}
 const mount=(id:number,generation?:string)=>environment.client({op:'mount',id,module:'surface.js',now:0},onFault(id,generation))
 let frame:any;let mountError:any
 try {frame=await mount(1)} catch(error) {mountError={message:(error as Error).message,phase:(error as any).phase}}
 if(mode.startsWith('render-')) {
  let alive=environment
  if(mode==='render-budget-dispose') await environment.client({op:'dispose',id:1})
  if(mode==='render-budget-unload') {await environment.dispose();alive=await host.load(declaration)}
  await new Promise(resolve=>setTimeout(resolve,mode==='render-budget'?1100:80))
  console.log(JSON.stringify({mountError,warnings,faults,closed,hooks:await alive.invoke(alive.registrations[0]!.id,[])}))
 } else {
  await mount(2)
  const act=async()=>{
   if(event==='draw') return
   if(event==='tick') return environment.client({op:'frame',id:1,now:1})
   if(event==='held') {await environment.client({op:'press',id:1,handle:frame.tree.press.handle,event:{}});return}
   await environment.client({op:event as 'key'|'pointer',id:1,event:{key:'start',type:'down'}})
  }
  const actionResult=await act()
  let observation:any
  if(mode==='bare') {
   const output=event==='draw'?frame:event==='tick'?actionResult:await environment.client({op:'frame',id:1,now:0})
   observation=event==='draw'?{bare:output.tree.children[0]==='true'}:output.post
  } else if(mode==='unmounted'||mode==='generation'||mode==='unloaded') {
   // The old callback really rejects before its numeric seat is retired.
   await environment.client({op:'key',id:1,event:{key:'release'}}).catch(()=>{})
   if(mode==='generation'||mode==='unloaded') for(let n=0;n<50 && !heldFault;n++) await new Promise(resolve=>setTimeout(resolve,2))
   if(mode==='unloaded') {
    await environment.dispose()
    oldUnloaded=await environment.client({op:'frame',id:1}).then(()=>undefined,error=>error.message)
    liveEnvironment=await host.load(declaration)
    await liveEnvironment.client({op:'mount',id:1,module:'surface.js',now:0},onFault(1,'new'))
    await liveEnvironment.client({op:'mount',id:2,module:'surface.js',now:0},onFault(2,'new'))
    heldFault?.()
   } else await environment.client({op:'dispose',id:1})
   if(mode==='generation') {
    await new Promise(resolve=>setTimeout(resolve,20))
    await mount(1,'new')
    heldInvalid?.()
    invalidWarnings=warnings.length
    heldFault?.()
   }
   await new Promise(resolve=>setTimeout(resolve,40))
  } else if(shape!=='getter' && mode!=='success') {
   await environment.client({op:'key',id:1,event:{key:'release'}}).catch(()=>{})
  }
  await new Promise(resolve=>setTimeout(resolve,80))
  const first=await liveEnvironment.client({op:'frame',id:1,now:0}).then(value=>value,error=>({error:(error as Error).message}))
  const sibling=await liveEnvironment.client({op:'frame',id:2,now:0})
  console.log(JSON.stringify({observation,first,sibling,warnings,faults,heldDelivered,invalidWarnings,oldUnloaded,hooks:await liveEnvironment.invoke(liveEnvironment.registrations[0]!.id,[])}))
 }
} finally {await host.dispose()}
