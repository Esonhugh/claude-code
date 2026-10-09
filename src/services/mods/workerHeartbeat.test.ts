import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModEnvironmentHost } from './environment.js'
import { createModsRuntime, type ModDiagnostic } from './runtime.js'
import type { ModDeclaration } from './types.js'

function declaration(name: string, source: string): ModDeclaration {
  return {name,storageId:name+'@inline',pluginRoot:'/fixture',entrypoints:['/fixture/register.js'],
    modules:[{path:'/fixture/register.js',source}],links:[],events:['tool.call'],calls:[],nextTiers:[],options:{},tier:'user',fingerprint:source}
}
test.each(['sync','after-host-await'])('real shared Worker heartbeat attributes %s CPU without blaming another pending environment', async mode => {
  const died=Promise.withResolvers<{error:Error;fault:unknown}>()
  const host=createModEnvironmentHost({onDied:(error,...args:unknown[])=>died.resolve({error,fault:args[0]})})
  try {
    if (mode === 'sync') await new Promise(resolve => setTimeout(resolve, 1200))
    const sibling=await host.load(declaration('sibling',`export function register(on){on('tool.call',()=>({wait:()=>new Promise(()=>{}),alive:()=>true}))}`))
    const bad=await host.load(declaration('culprit',`export function register(on){on('tool.call',($)=>({spin:${mode==='sync'?'':'async '}()=>{${mode==='sync'?'void $.entered()':'await $.entered()'};for(;;){}}}))}`))
    const oldSibling=await sibling.invoke(sibling.registrations[0]!.id,[]) as {wait():Promise<unknown>;alive():Promise<boolean>}
    const entered=Promise.withResolvers<void>()
    const oldBad=await bad.invoke(bad.registrations[0]!.id,[{entered:()=>entered.resolve()}]) as {spin():Promise<unknown>}
    const waiting=oldSibling.wait().catch(error=>error)
    const start=performance.now(),failure=oldBad.spin().catch(error=>error)
    await entered.promise
    const death=await died.promise
    expect(performance.now()-start).toBeGreaterThanOrEqual(5900)
    expect(performance.now()-start).toBeLessThan(7500)
    expect(death.fault).toMatchObject({cause:'heartbeat',culprit:{environment:bad.id,plugin:'culprit',evidence:mode==='sync'?'stack':'resumed',stage:'invoke'}})
    expect(await waiting).toBe(death.error)
    expect(await failure).toBe(death.error)
    await expect(oldSibling.alive()).rejects.toThrow('unloaded')
    await host.dispose()
  } finally {await host.dispose()}
},10000)

test('real shared Worker leaves a normal 6500ms asynchronous host wait alive', async()=>{
  let died=false
  const host=createModEnvironmentHost({onDied:()=>{died=true}})
  try {
    const env=await host.load(declaration('yielding',`export function register(on){on('tool.call',async($)=>{await $.waiting();return true})}`))
    expect(await env.invoke(env.registrations[0]!.id,[{waiting:()=>new Promise(resolve=>setTimeout(resolve,6500))}])).toBe(true)
    expect(died).toBe(false)
  } finally {await host.dispose()}
},10000)

test('real runtime retires CPU culprit, closes old catch/handles, and retries known load failures while rebuilding survivors',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mods-worker-heartbeat-'))
  const fixture=async(name:string,source:string)=>{
    const pluginRoot=await mkdtemp(join(root,name+'-')),entry=join(pluginRoot,'register.ts')
    await writeFile(entry,source);return {name,storageId:name+'@inline',pluginRoot,entrypoints:[entry]}
  }
  const bad=await fixture('culprit',`export function register(on){on('command.run',()=>({text:'explicit reload'}));on('tool.call',async($,e,next)=>{if(e.command==='spin'){await $.clock.sleep(0);for(;;){}}return next(e)}).catch(()=>({result:'old-catch'}))}`)
  const survivor=await fixture('survivor',`let n=0;export function register(on){on('tool.call',()=>({result:++n,oldHandle:()=>n}))}`)
  const rejected=await fixture('not-admitted',`export function register(on){throw Error('not admitted')}`)
  const events:ModDiagnostic[]=[]
  const value=createModsRuntime({onDiagnostic:event=>events.push(event)})
  try {
    await value.reconcile([bad,survivor,rejected])
    const input={tool:'Bash',tool_use_id:'heartbeat',command:'normal'}
    const first=await value.dispatch('tool.call',input,async()=>({result:'core'})) as {result:number;oldHandle():Promise<number>}
    expect(first.result).toBe(1)
    const result=await value.dispatch('tool.call',{...input,command:'spin'},async()=>({result:'core'})) as {result:unknown}
    expect(result.result).not.toBe('old-catch')
    // bind shares the queued recovery barrier; this is a production consumer.
    await value.bind({cwd:root,surface:null,isInteractive:false,sessionId:'heartbeat'})
    const second=await value.dispatch('tool.call',input,async()=>({result:'core'})) as {result:number}
    expect(second.result).toBe(1)
    await expect(first.oldHandle()).rejects.toThrow('unloaded')
    expect(events.filter(event=>event.stage==='worker')).toHaveLength(1)
    expect(events.find(event=>event.stage==='worker')).toMatchObject({plugin:'culprit',message:expect.stringContaining('heartbeat')})
    expect(events.find(event=>event.stage==='worker')!.workerFault).toMatchObject({cause:'heartbeat',culprit:{storageId:'culprit@inline',evidence:'resumed',stage:'invoke',requestId:expect.any(Number),handle:expect.any(Number)}})
    expect(events.filter(event=>event.plugin==='not-admitted')).toEqual([
      {plugin:'not-admitted',stage:'load',message:'not admitted'},
      {plugin:'not-admitted',stage:'load',message:'not admitted'},
    ])
    // A still declared culprit requires explicit reload before it can execute again.
    const again=performance.now()
    expect(await value.dispatch('tool.call',{...input,command:'spin'},async()=>({result:'core'}))).toMatchObject({result:2})
    expect(performance.now()-again).toBeLessThan(500)
    expect(value.hasHooks('command.run')).toBe(false)
    await value.reconcile([bad,survivor])
    expect(value.hasHooks('command.run')).toBe(true)
    expect(await value.dispatch('command.run',{name:'custom',args:''},async()=>({text:'core'}))).toEqual({text:'explicit reload'})
  } finally {try {await value.dispose()} finally {await rm(root,{recursive:true,force:true})}}
},12000)
