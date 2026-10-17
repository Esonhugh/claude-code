import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime, type ModDiagnostic } from './runtime.js'

async function fixture(root:string,name:string,source:string) {
  const pluginRoot=await mkdtemp(join(root,name+'-')),entry=join(pluginRoot,'register.ts')
  await writeFile(entry,source)
  return {name,storageId:name+'@inline',pluginRoot,entrypoints:[entry]}
}
const input={tool:'Bash',tool_use_id:'custom-deadline',command:'wait'}

test('actual public custom Promise rejects at 10000ms through its live registration.catch while the shared Worker survives',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mods-custom-deadline-')),events:ModDiagnostic[]=[]
  const value=createModsRuntime({onDiagnostic:event=>events.push(event)})
  let observation:ReturnType<typeof setTimeout>|undefined
  try {
    const consumer=await fixture(root,'deadline-consumer',`export function register(on){on('tool.call',async($,e)=>({result:await $.slow.wait({})})).catch(($,e,next)=>({result:{caught:next.error.message}}))}`)
    const provider=await fixture(root,'deadline-provider',`export function register(on){on('engine.create',async($,e,next)=>{const built=await next(e);return {...built,slow:{wait:()=>new Promise(()=>{}),peek:()=>true}}})}`)
    await value.reconcile([consumer,provider])
    expect(events).toEqual([])
    const start=performance.now()
    const output=value.dispatch('tool.call',input,async()=>({result:'core'}))
    // Observe teardown rejection without changing the Promise used by the assertions.
    void output.catch(()=>{})
    const observed=await Promise.race([output,new Promise(resolve=>{observation=setTimeout(()=>resolve('still pending after 11000ms'),11000)})])
    clearTimeout(observation)
    expect(observed).toEqual({result:{caught:expect.stringContaining('slow.wait: deadline-provider did not answer within 10000ms')}})
    expect(performance.now()-start).toBeGreaterThanOrEqual(9900)
    expect(performance.now()-start).toBeLessThan(10750)
    expect(events.filter(event=>event.stage==='worker')).toEqual([])
    await writeFile(consumer.entrypoints[0]!,`export function register(on){on('tool.call',async($)=>({result:await $.slow.peek({})}))}`)
    await value.reconcile([consumer,provider])
    expect(await value.dispatch('tool.call',input,async()=>({result:'core'}))).toEqual({result:true})
  } finally {clearTimeout(observation);try {await value.dispose()} finally {await rm(root,{recursive:true,force:true})}}
},14000)

test('a public custom timeout ignores its late reply without aborting its body or a normal simultaneous host wait',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mods-custom-late-reply-')),events:ModDiagnostic[]=[]
  const value=createModsRuntime({onDiagnostic:event=>events.push(event)})
  let observation:ReturnType<typeof setTimeout>|undefined,holdTimer:ReturnType<typeof setTimeout>|undefined
  try {
    const consumer=await fixture(root,'late-consumer',`export function register(on){
      on('tool.call',async($,e)=>({result:e.command==='peek'?await $.slow.peek({}):await $.slow.wait({})})).catch(($,e,next)=>({result:{caught:next.error.message}}));
      on('command.run',($,e,next)=>next(e))
    }`)
    const provider=await fixture(root,'late-provider',`let finished=0;export function register(on){on('engine.create',async($,e,next)=>{const built=await next(e);return {...built,slow:{wait:async()=>{await built.clock.sleep(10300);finished++;return 'late body result'},peek:()=>finished}}})}`)
    await value.reconcile([consumer,provider])
    expect(events).toEqual([])
    let heldSettled=false
    const held=value.dispatch('command.run',{name:'hold',args:''},async()=>{
      await new Promise<void>(resolve=>{holdTimer=setTimeout(resolve,10600)})
      return {text:'ordinary host wait survived'}
    }).finally(()=>{heldSettled=true})
    void held.catch(()=>{})
    const start=performance.now()
    const output=value.dispatch('tool.call',input,async()=>({result:'core'}))
    // Observe teardown rejection without changing the Promise used by the assertions.
    void output.catch(()=>{})
    const observed=await Promise.race([output,new Promise(resolve=>{observation=setTimeout(()=>resolve('still pending after 11000ms'),11000)})])
    clearTimeout(observation)
    expect(observed).toEqual({result:{caught:expect.stringContaining('slow.wait: late-provider did not answer within 10000ms')}})
    expect(performance.now()-start).toBeGreaterThanOrEqual(9900)
    expect(performance.now()-start).toBeLessThan(10750)
    expect(heldSettled).toBe(false)
    expect(await held).toEqual({text:'ordinary host wait survived'})
    // The guest really completed after the host's settlement; it was not aborted.
    expect(await value.dispatch('tool.call',{...input,command:'peek'},async()=>({result:'core'}))).toEqual({result:1})
    expect(await output).toEqual(observed)
    expect(events.filter(event=>event.stage==='worker')).toEqual([])
  } finally {clearTimeout(observation);clearTimeout(holdTimer);try {await value.dispose()} finally {await rm(root,{recursive:true,force:true})}}
},14000)
