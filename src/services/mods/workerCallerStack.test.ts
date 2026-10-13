import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createModEnvironmentHost, createModUiBridge } from './environment.js'
import { createModsRuntime, type ModDiagnostic } from './runtime.js'
import type { ModDeclaration } from './types.js'
import type { ModWorkerFault } from './protocol.js'

function declaration(name:string,source:string,events=['ui.resolve']):ModDeclaration {
  return {name,storageId:name+'@inline',pluginRoot:'/fixture',entrypoints:['/fixture/register.js'],modules:[{path:'/fixture/register.js',source}],links:[],events,calls:[],nextTiers:[],options:{},tier:'user',fingerprint:source}
}
function captureWorkerStamp() {
  const NativeWorker=globalThis.Worker, stamps:Int32Array[]=[]
  globalThis.Worker=class extends NativeWorker {
    constructor(url:string|URL,options?:WorkerOptions) {
      super(url,options)
      const data=(options as WorkerOptions & {data?:{stamp?:SharedArrayBuffer}}|undefined)?.data
      if(data?.stamp) stamps.push(new Int32Array(data.stamp))
    }
  }
  return {stamps,restore:()=>{globalThis.Worker=NativeWorker}}
}
const uiEvent={surface:'terminal',component:'Pane',requestId:'caller-stack'}

test('real published UI constructor blames its resolving consumer before the CPU provider, ignoring forged props',async()=>{
  const capture=captureWorkerStamp(), died=Promise.withResolvers<ModWorkerFault>()
  const host=createModEnvironmentHost({onDied:(_error,fault)=>died.resolve(fault)})
  try {
    const provider=await host.load(declaration('ui-provider',`export function register(on){on('ui.resolve',()=>({Text:()=>{for(;;){}}}))}`))
    const consumer=await host.load(declaration('ui-consumer',`export function register(on){on('ui.render',($,e)=>$.ui.resolve(e).Text({callers:[1],environment:1,serving:1}))}`,['ui.render']))
    const table=await provider.invoke(provider.registrations[0]!.id,[]) as object
    await (await host.prepareUiTables(new Map([[consumer,new Map([['terminal:Pane',table]])]]),[consumer]))()
    const failed=consumer.invoke(consumer.registrations[0]!.id,[{ui:createModUiBridge({})},uiEvent],undefined,1).catch(error=>error)
    const fault=await died.promise
    expect(fault).toMatchObject({cause:'heartbeat',culprit:{environment:consumer.id,plugin:'ui-consumer',evidence:'stack',stage:'invoke'}})
    expect(fault.culprit).not.toHaveProperty('settledRequestId')
    expect(Array.from(capture.stamps[0]!.slice(6))).toEqual([consumer.id,0,0,0,0,0,0])
    expect(String(await failed)).toContain('heartbeat')
  } finally {await host.dispose();capture.restore()}
},10000)

test.each([2,7,8])('real custom noun chain of %i callers retains only seven host-owned IDs',async layers=>{
  const root=await mkdtemp(join(tmpdir(),'mods-worker-callers-')), capture=captureWorkerStamp()
  const events:ModDiagnostic[]=[]
  const value=createModsRuntime({onDiagnostic:event=>events.push(event)})
  const fixture=async(name:string,source:string)=>{
    const pluginRoot=await mkdtemp(join(root,name+'-')),entry=join(pluginRoot,'register.ts')
    await writeFile(entry,source);return {name,storageId:name+'@inline',pluginRoot,entrypoints:[entry]}
  }
  try {
    const consumer=await fixture('chain-consumer',`export function register(on){on('tool.call',async($)=>({result:await $.bridge0.run({callers:[99999],serving:99999,environment:99999})}))}`)
    const providers=[]
    for(let i=0;i<layers;i++) providers.push(await fixture('chain-provider-'+i,`export function register(on){on('engine.create',async($,e,next)=>{const built=await next(e);return {...built,bridge${i}:{run:${i===layers-1?'()=>{for(;;){}}':'input=>built.bridge'+(i+1)+'.run(input)'}}}})}`))
    await value.reconcile([consumer,...providers])
    expect(events).toEqual([])
    const failed=value.dispatch('tool.call',{tool:'Bash',tool_use_id:'callers',command:'spin'},async()=>({result:'core'}))
    const result=await failed
    expect(events.filter(event=>event.stage==='worker')).toHaveLength(1)
    const fault=events.find(event=>event.stage==='worker')?.workerFault
    expect(fault).toMatchObject({cause:'heartbeat',culprit:{plugin:'chain-consumer',evidence:'stack',stage:'unknown'}})
    expect(fault!.culprit).not.toHaveProperty('requestId')
    expect(fault!.culprit).not.toHaveProperty('settledRequestId')
    const stamp=capture.stamps[0]!,first=fault!.culprit!.environment
    expect(Array.from(stamp.slice(6))).toEqual(Array.from({length:7},(_,i)=>i<layers?first+i:0))
    expect(result).toEqual({result:'core'})
    await value.bind({cwd:root,surface:null,isInteractive:false,sessionId:'caller-stack'})
  } finally {try {await value.dispose()} finally {capture.restore();await rm(root,{recursive:true,force:true})}}
},12000)

test('real synchronous UI return and throw restore every caller slot before unrelated work',async()=>{
  const capture=captureWorkerStamp(),host=createModEnvironmentHost()
  try {
    const provider=await host.load(declaration('restore-provider',`export function register(on){on('ui.resolve',()=>({Text:props=>{if(props.fail)throw Error('constructor failed');return {type:'Text',props:{children:'ok'}}}}))}`))
    const consumer=await host.load(declaration('restore-consumer',`export function register(on){on('ui.render',($,e)=>{try{return $.ui.resolve(e).Text({fail:e.fail})}catch(error){return {type:'Text',props:{children:error.message}}}})}`,['ui.render']))
    const table=await provider.invoke(provider.registrations[0]!.id,[]) as object
    await (await host.prepareUiTables(new Map([[consumer,new Map([['terminal:Pane',table]])]]),[consumer]))()
    for(const fail of [false,true]) {
      expect(await consumer.invoke(consumer.registrations[0]!.id,[{ui:createModUiBridge({})},{...uiEvent,fail}],undefined,1)).toMatchObject({type:'Text',props:{children:fail?'constructor failed':'ok'}})
      expect(capture.stamps[0]!.length).toBe(13)
      expect(Array.from(capture.stamps[0]!.slice(6))).toEqual([0,0,0,0,0,0,0])
    }
  } finally {await host.dispose();capture.restore()}
})

test('real custom interface to published UI constructor preserves its original serving caller',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mods-worker-ui-callers-')),capture=captureWorkerStamp()
  const events:ModDiagnostic[]=[],value=createModsRuntime({onDiagnostic:event=>events.push(event)})
  const fixture=async(name:string,source:string)=>{
    const pluginRoot=await mkdtemp(join(root,name+'-')),entry=join(pluginRoot,'register.ts')
    await writeFile(entry,source);return {name,storageId:name+'@inline',pluginRoot,entrypoints:[entry]}
  }
  try {
    const consumer=await fixture('mixed-consumer',`export function register(on){on('tool.call',{tool:'Spin'},async($)=>({result:await $.drawing.run({callers:[3],serving:3})}))}`)
    const wrapper=await fixture('mixed-wrapper',`let constructor;export function register(on){
      on('engine.create',async($,e,next)=>{const built=await next(e);return {...built,drawing:{run:input=>constructor(input)}}});
      on('tool.call',{tool:'Prepare'},($)=>{constructor=$.ui.resolve({surface:'terminal',component:'Pane'}).Text;return {result:'ready'}})
    }`)
    const provider=await fixture('mixed-ui-provider',`export function register(on){on('ui.resolve',async($,e,next)=>{const elements=await next(e);return {...elements,Text:()=>{for(;;){}}}})}`)
    await value.bind({cwd:root,surface:'terminal',isInteractive:true,sessionId:'mixed-callers'})
    await value.reconcile([consumer,wrapper,provider])
    expect(events).toEqual([])
    expect(await value.dispatch('tool.call',{tool:'Prepare',tool_use_id:'prepare'},async()=>({result:'core'}))).toEqual({result:'ready'})
    expect(await value.dispatch('tool.call',{tool:'Spin',tool_use_id:'spin'},async()=>({result:'core'}))).toEqual({result:'core'})
    const fault=events.find(event=>event.stage==='worker')!.workerFault!
    expect(fault.culprit).toMatchObject({plugin:'mixed-consumer',evidence:'stack',stage:'unknown'})
    expect(fault.culprit).not.toHaveProperty('requestId')
    const first=fault.culprit!.environment
    expect(Array.from(capture.stamps[0]!.slice(6))).toEqual([first,first+1,0,0,0,0,0])
    await value.bind({cwd:root,surface:null,isInteractive:false,sessionId:'mixed-callers'})
  } finally {try {await value.dispose()} finally {capture.restore();await rm(root,{recursive:true,force:true})}}
},12000)

test('a real detached custom call cannot reuse an already settled serving frame or forge its IDs',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mods-worker-settled-callers-')),capture=captureWorkerStamp()
  const events:ModDiagnostic[]=[],died=Promise.withResolvers<ModDiagnostic>()
  const value=createModsRuntime({onDiagnostic:event=>{events.push(event);if(event.stage==='worker')died.resolve(event)}})
  const fixture=async(name:string,source:string)=>{
    const pluginRoot=await mkdtemp(join(root,name+'-')),entry=join(pluginRoot,'register.ts')
    await writeFile(entry,source);return {name,storageId:name+'@inline',pluginRoot,entrypoints:[entry]}
  }
  try {
    const consumer=await fixture('settled-consumer',`export function register(on){on('tool.call',{tool:'Start'},async($)=>({result:await $.later.start({})}));on('tool.call',{tool:'Wait'},()=>new Promise(()=>{}))}`)
    const timer=await fixture('detached-caller',`export function register(on){on('engine.create',async($,e,next)=>{const built=await next(e);return {...built,later:{start:()=>{AbortSignal.timeout(20).addEventListener('abort',()=>built.spin.run({callers:[1],serving:1,environment:1}));return 'ready'}}}})}`)
    const provider=await fixture('detached-cpu',`export function register(on){on('engine.create',async($,e,next)=>{const built=await next(e);return {...built,spin:{run:()=>{for(;;){}}}}})}`)
    await value.reconcile([consumer,timer,provider])
    expect(events).toEqual([])
    expect(await value.dispatch('tool.call',{tool:'Start',tool_use_id:'start'},async()=>({result:'core'}))).toEqual({result:'ready'})
    const waiting=value.dispatch('tool.call',{tool:'Wait',tool_use_id:'hold'},async()=>({result:'core'})).catch(error=>error)
    const event=await died.promise
    expect(event.workerFault!.culprit).toMatchObject({plugin:'detached-caller',evidence:'stack',stage:'unknown'})
    expect(event.workerFault!.culprit).not.toHaveProperty('requestId')
    expect(event.workerFault!.culprit).not.toHaveProperty('settledRequestId')
    expect(Array.from(capture.stamps[0]!.slice(6))).toEqual([event.workerFault!.culprit!.environment,0,0,0,0,0,0])
    await waiting
    await value.bind({cwd:root,surface:null,isInteractive:false,sessionId:'settled-callers'})
  } finally {try {await value.dispose()} finally {capture.restore();await rm(root,{recursive:true,force:true})}}
},12000)

test.each([false,true])('a nested real UI constructor %s restores the enclosing custom caller frame before synchronous CPU',async fail=>{
  const root=await mkdtemp(join(tmpdir(),'mods-worker-restore-callers-')),capture=captureWorkerStamp()
  const events:ModDiagnostic[]=[],value=createModsRuntime({onDiagnostic:event=>events.push(event)})
  const fixture=async(name:string,source:string)=>{
    const pluginRoot=await mkdtemp(join(root,name+'-')),entry=join(pluginRoot,'register.ts')
    await writeFile(entry,source);return {name,storageId:name+'@inline',pluginRoot,entrypoints:[entry]}
  }
  try {
    const consumer=await fixture('outer-consumer',`export function register(on){on('tool.call',{tool:'Spin'},async($)=>({result:await $.drawing.run({})}))}`)
    const wrapper=await fixture('outer-wrapper',`let constructor;export function register(on){
      on('engine.create',async($,e,next)=>{const built=await next(e);return {...built,drawing:{run:()=>{try{constructor({fail:${fail}})}catch(error){}for(;;){}}}}});
      on('tool.call',{tool:'Prepare'},($)=>{constructor=$.ui.resolve({surface:'terminal',component:'Pane'}).Text;return {result:'ready'}})
    }`)
    const provider=await fixture('returning-ui-provider',`export function register(on){on('ui.resolve',async($,e,next)=>{const elements=await next(e);return {...elements,Text:props=>{if(props.fail)throw Error('UI throw');return elements.Text({children:'ok'})}}})}`)
    await value.bind({cwd:root,surface:'terminal',isInteractive:true,sessionId:'restore-callers'})
    await value.reconcile([consumer,wrapper,provider])
    expect(events).toEqual([])
    expect(await value.dispatch('tool.call',{tool:'Prepare',tool_use_id:'prepare'},async()=>({result:'core'}))).toEqual({result:'ready'})
    expect(await value.dispatch('tool.call',{tool:'Spin',tool_use_id:'spin'},async()=>({result:'core'}))).toEqual({result:'core'})
    const fault=events.find(event=>event.stage==='worker')!.workerFault!
    expect(fault.culprit).toMatchObject({plugin:'outer-consumer',evidence:'stack',stage:'unknown'})
    expect(Array.from(capture.stamps[0]!.slice(6))).toEqual([fault.culprit!.environment,0,0,0,0,0,0])
    await value.bind({cwd:root,surface:null,isInteractive:false,sessionId:'restore-callers'})
  } finally {try {await value.dispose()} finally {capture.restore();await rm(root,{recursive:true,force:true})}}
},12000)
