import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime, type ModDiagnostic, type ModPluginInput } from './runtime.js'

const input={tool:'Bash',tool_use_id:'reload-oracle',command:'normal'}
const monitorSource=`let count=0;export function register(on){on('clock.now',($,e,next)=>{count++;return next(e)});on('tool.call',()=>({result:count}))}`
const failingSource=(kind='throw',marker='')=>`${marker}export function register(on,options){on('engine.create',async($,e,next)=>{const built=await next(e);await built.clock.now();${kind==='shape'?"return 1":"throw Error('failed fold:'+options.flag)"}})}`
async function fixture(root:string,name:string,source:string):Promise<ModPluginInput>{
  const pluginRoot=await mkdtemp(join(root,name+'-')),entry=join(pluginRoot,'register.ts')
  await writeFile(entry,source);return {name,storageId:name+'@inline',pluginRoot,entrypoints:[entry]}
}
async function setup(){
  const root=await mkdtemp(join(tmpdir(),'mods-worker-reload-')),events:ModDiagnostic[]=[],workers:Worker[]=[]
  const RealWorker=globalThis.Worker
  globalThis.Worker=class extends RealWorker {constructor(url:string|URL,options?:WorkerOptions){super(url,options);workers.push(this)}} as typeof Worker
  const value=createModsRuntime({onDiagnostic:event=>events.push(event)})
  const binding={cwd:root,surface:null,isInteractive:false,sessionId:'worker-reload'}
  return {root,events,workers,value,binding,async close(){try{await value.dispose()}finally{globalThis.Worker=RealWorker;await rm(root,{recursive:true,force:true})}}}
}
async function crash(host:Awaited<ReturnType<typeof setup>>){
  const before=host.events.filter(event=>event.stage==='worker').length
  host.workers.at(-1)!.terminate()
  const deadline=performance.now()+500
  while(host.events.filter(event=>event.stage==='worker').length===before&&performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5))
  expect(host.events.filter(event=>event.stage==='worker')).toHaveLength(before+1)
  expect(host.events.filter(event=>event.stage==='worker').at(-1)!.workerFault).toMatchObject({cause:'exit'})
  expect(host.events.filter(event=>event.stage==='worker').at(-1)!.workerFault).not.toHaveProperty('culprit')
  await host.value.bind(host.binding)
}
async function count(host:Awaited<ReturnType<typeof setup>>){return (await host.value.dispatch('tool.call',input,async()=>({result:'core'})) as {result:unknown}).result}

test('three real unknown Worker exits turn ordinary Mods off until an explicit unchanged reconcile',async()=>{
  const host=await setup()
  try{
    const plugin=await fixture(host.root,'ordinary',`let n=0;export function register(on){on('tool.call',()=>({result:++n}))}`)
    await host.value.reconcile([plugin])
    for(let n=0;n<3;n++){
      expect(await count(host)).toBe(1)
      await crash(host)
      if(n<2)expect(host.value.hasHooks('tool.call')).toBe(true)
    }
    expect(host.value.hasHooks('tool.call')).toBe(false)
    expect(await count(host)).toBe('core')
    expect(host.events.some(event=>event.stage==='worker.disable'&&event.message.includes('3'))).toBe(true)
    await host.value.reconcile([plugin])
    expect(await count(host)).toBe(1)
    expect(host.value.hasHooks('tool.call')).toBe(true)
  }finally{await host.close()}
})

test('an unchanged manual reconcile resets unknown crash strikes; bind alone does not',async()=>{
  const host=await setup()
  try{
    const plugin=await fixture(host.root,'reset',`export function register(on){on('tool.call',()=>({result:true}))}`)
    await host.value.reconcile([plugin]);await crash(host);await crash(host)
    expect(await count(host)).toBe(true)
    await host.value.reconcile([plugin])
    await crash(host);await crash(host)
    expect(await count(host)).toBe(true)
    await crash(host)
    expect(host.value.hasHooks('tool.call')).toBe(false)
  }finally{await host.close()}
})

test('a known CPU culprit neither increments nor resets earlier unknown strikes',async()=>{
  const host=await setup()
  try{
    const bad=await fixture(host.root,'known-cpu',`export function register(on){on('tool.call',($,e,next)=>{if(e.command==='spin')for(;;){}return next(e)})}`)
    const survivor=await fixture(host.root,'survivor',`export function register(on){on('tool.call',()=>({result:'survivor'}))}`)
    await host.value.reconcile([bad,survivor]);await crash(host);await crash(host)
    expect(await count(host)).toBe('survivor')
    await host.value.dispatch('tool.call',{...input,command:'spin'},async()=>({result:'core'}))
    await host.value.bind(host.binding)
    expect(host.events.filter(event=>event.stage==='worker').at(-1)!.workerFault).toMatchObject({cause:'heartbeat',culprit:{plugin:'known-cpu',evidence:'stack'}})
    expect(await count(host)).toBe('survivor')
    await crash(host)
    expect(host.value.hasHooks('tool.call')).toBe(false)
  }finally{await host.close()}
},10000)

test('automatic recovery uses pinned known declaration sources rather than new files on disk',async()=>{
  const host=await setup()
  try{
    const plugin=await fixture(host.root,'pinned',`export function register(on){on('tool.call',()=>({result:'old'}))}`)
    await host.value.reconcile([plugin])
    await writeFile(plugin.entrypoints[0]!,`export function register(on){on('tool.call',()=>({result:'new'}))}`)
    await crash(host)
    expect(await count(host)).toBe('old')
    await host.value.reconcile([plugin])
    expect(await count(host)).toBe('new')
  }finally{await host.close()}
})

test.each(['throw','shape'])('unchanged %s engine.create failures skip real guest reexecution while the live set is unchanged',async kind=>{
  const host=await setup()
  try{
    const monitor=await fixture(host.root,'monitor',monitorSource),bad=await fixture(host.root,'failed',failingSource(kind))
    await host.value.reconcile([monitor,bad]);expect(await count(host)).toBe(1)
    await host.value.reconcile([monitor,bad]);await host.value.reconcile([monitor,bad])
    expect(await count(host)).toBe(1)
    expect(host.events.filter(event=>event.stage==='engine.create'&&event.plugin==='failed')).toHaveLength(1)
  }finally{await host.close()}
})

test.each(['source','options','version','name','tier','root','entrypoint','static-link','order','live-source','join','leave','remove-and-return'])('real %s change releases the failed-step gate',async change=>{
  const host=await setup()
  try{
    const monitor=await fixture(host.root,'monitor',monitorSource),healthy=await fixture(host.root,'healthy',`export function register(on){on('command.run',()=>({text:'healthy'}))}`)
    let bad=await fixture(host.root,'failed',failingSource())
    if(change==='static-link'){
      await writeFile(join(bad.pluginRoot,'linked.ts'),`export const label='old'`)
      await writeFile(bad.entrypoints[0]!,`import {label} from './linked.ts';export function register(on){on('engine.create',async($,e,next)=>{const built=await next(e);await built.clock.now();throw Error(label)})}`)
    }
    await host.value.reconcile([monitor,healthy,bad]);expect(await count(host)).toBe(1)
    await host.value.reconcile([monitor,healthy,bad]);expect(await count(host)).toBe(1)
    let next=[monitor,healthy,bad]
    if(change==='source')await writeFile(bad.entrypoints[0]!,failingSource('throw',`const changed='actual';`))
    if(change==='options'){bad={...bad,options:{flag:2},fingerprintOptions:{fixed:true}};next=[monitor,healthy,bad]}
    if(change==='version'){bad={...bad,version:'2'};next=[monitor,healthy,bad]}
    if(change==='name'){bad={...bad,name:'renamed'};next=[monitor,healthy,bad]}
    if(change==='tier'){bad={...bad,tier:'append'};next=[monitor,healthy,bad]}
    if(change==='root'){
      const moved=await mkdtemp(join(host.root,'moved-')),entry=join(moved,'register.ts');await copyFile(bad.entrypoints[0]!,entry)
      bad={...bad,pluginRoot:moved,entrypoints:[entry]};next=[monitor,healthy,bad]
    }
    if(change==='entrypoint'){const entry=join(bad.pluginRoot,'second.ts');await copyFile(bad.entrypoints[0]!,entry);bad={...bad,entrypoints:[entry]};next=[monitor,healthy,bad]}
    if(change==='static-link')await writeFile(join(bad.pluginRoot,'linked.ts'),`export const label='new'`)
    if(change==='order')next=[monitor,bad,healthy]
    if(change==='live-source')await writeFile(healthy.entrypoints[0]!,`export function register(on){on('command.run',()=>({text:'changed'}))}`)
    if(change==='join')next=[monitor,healthy,bad,await fixture(host.root,'joining',`export function register(on){}`)]
    if(change==='leave')next=[monitor,bad]
    if(change==='remove-and-return'){await host.value.reconcile([monitor,healthy]);next=[monitor,healthy,bad]}
    await host.value.reconcile(next)
    expect(await count(host)).toBe(2)
  }finally{await host.close()}
})

test('a fingerprint-only cache hint does not invalidate identical actual args or shown metadata',async()=>{
  const host=await setup()
  try{
    const monitor=await fixture(host.root,'monitor',monitorSource),bad=await fixture(host.root,'failed',failingSource())
    await host.value.reconcile([monitor,bad]);expect(await count(host)).toBe(1)
    await host.value.reconcile([monitor,{...bad,fingerprintOptions:{hint:'different'}}])
    expect(await count(host)).toBe(1)
  }finally{await host.close()}
})

test('the exact official dynamic-import text regex prevents unchanged failure gating even inside a string',async()=>{
  const host=await setup()
  try{
    const monitor=await fixture(host.root,'monitor',monitorSource),bad=await fixture(host.root,'failed',failingSource('throw',`const marker='import (';`))
    await host.value.reconcile([monitor,bad]);expect(await count(host)).toBe(1)
    await host.value.reconcile([monitor,bad]);expect(await count(host)).toBe(2)
  }finally{await host.close()}
})

test('automatic respawn retains unchanged failed-step gating even if its static source changes on disk',async()=>{
  const host=await setup()
  try{
    const monitor=await fixture(host.root,'monitor',monitorSource),bad=await fixture(host.root,'failed',failingSource())
    await host.value.reconcile([monitor,bad]);expect(await count(host)).toBe(1)
    await writeFile(bad.entrypoints[0]!,`export function register(on){on('command.run',()=>({text:'should require manual scan'}))}`)
    await crash(host)
    expect(host.value.hasHooks('command.run')).toBe(false)
    await host.value.reconcile([monitor,bad])
    expect(host.value.hasHooks('command.run')).toBe(true)
  }finally{await host.close()}
})

test('a real engine.create has no 10000ms budget and completes a longer normal host wait',async()=>{
  const host=await setup()
  try{
    const plugin=await fixture(host.root,'unbounded-create',`export function register(on){on('engine.create',async($,e,next)=>{const built=await next(e),proof={ms:next.budget.ms,unbounded:next.budget.remainingMs===Infinity};await built.clock.sleep(10100);return {...built,budgetProof:{read:()=>proof}}});on('tool.call',async($)=>({result:await $.budgetProof.read({})}))}`)
    const start=performance.now();await host.value.reconcile([plugin])
    expect(performance.now()-start).toBeGreaterThanOrEqual(10000)
    expect(await count(host)).toEqual({ms:0,unbounded:true})
    expect(host.events).toEqual([])
  }finally{await host.close()}
},14000)

test('a replacement that fails engine.create unloads its old hooks instead of keeping the earlier definition',async()=>{
  const host=await setup()
  try{
    const bad=await fixture(host.root,'replaced',`export function register(on){on('tool.call',()=>({result:'old'}));on('command.run',()=>({text:'old'}))}`),monitor=await fixture(host.root,'monitor',monitorSource)
    await host.value.reconcile([bad,monitor]);expect(await count(host)).toBe('old')
    await writeFile(bad.entrypoints[0]!,failingSource())
    await host.value.reconcile([bad,monitor])
    expect(host.value.hasHooks('command.run')).toBe(false)
    expect(await count(host)).toBe(1)
  }finally{await host.close()}
})


test('a real register failure remains in knownArgs and retries after an unknown respawn',async()=>{
  const host=await setup()
  try{
    const bad=await fixture(host.root,'load-failure',`export function register(on){throw Error('registration failed')}`),monitor=await fixture(host.root,'monitor',monitorSource)
    await host.value.reconcile([monitor,bad])
    expect(host.events.filter(event=>event.plugin==='load-failure')).toHaveLength(1)
    await crash(host)
    expect(host.events.filter(event=>event.plugin==='load-failure')).toEqual([
      {plugin:'load-failure',stage:'load',message:'registration failed'},
      {plugin:'load-failure',stage:'load',message:'registration failed'},
    ])
  }finally{await host.close()}
})

test('an actual plugin.register refusal removes its knownArgs before automatic recovery',async()=>{
  const host=await setup()
  try{
    const judge=await fixture(host.root,'judge',`export function register(on){on('plugin.register',($,e,next)=>e.name==='refused'?{refuse:'not accepted'}:next(e));on('tool.call',()=>({result:'judge'}))}`)
    const refused=await fixture(host.root,'refused',`export function register(on){on('command.run',()=>({text:'must not run'}))}`)
    await host.value.reconcile([judge,refused])
    expect(host.events.filter(event=>event.plugin==='refused')).toHaveLength(1)
    expect(host.value.hasHooks('command.run')).toBe(false)
    await crash(host)
    expect(host.events.filter(event=>event.plugin==='refused')).toHaveLength(1)
    expect(host.value.hasHooks('command.run')).toBe(false)
    expect(await count(host)).toBe('judge')
  }finally{await host.close()}
})

test('a successful real build clears the old failure gate before the original failed definition returns',async()=>{
  const host=await setup()
  try{
    const monitor=await fixture(host.root,'monitor',monitorSource),bad=await fixture(host.root,'failed',failingSource())
    await host.value.reconcile([monitor,bad]);expect(await count(host)).toBe(1)
    await writeFile(bad.entrypoints[0]!,`export function register(on){on('engine.create',async($,e,next)=>{const built=await next(e);await built.clock.now();return built})}`)
    await host.value.reconcile([monitor,bad]);expect(await count(host)).toBe(2)
    await writeFile(bad.entrypoints[0]!,failingSource())
    await host.value.reconcile([monitor,bad]);expect(await count(host)).toBe(3)
    expect(host.events.filter(event=>event.plugin==='failed'&&event.stage==='engine.create')).toHaveLength(2)
  }finally{await host.close()}
})
