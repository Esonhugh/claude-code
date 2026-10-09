import { expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dispatchModEvent } from './dispatch.js'
import { createModEnvironmentHost } from './environment.js'
import type { ModWorkerFault } from './protocol.js'
import { createModsRuntime, type ModDiagnostic } from './runtime.js'
import type { ModDeclaration } from './types.js'

function declaration(name: string, source: string): ModDeclaration {
  return {name,storageId:name+'@inline',pluginRoot:'/fixture',entrypoints:['/fixture/register.js'],
    modules:[{path:'/fixture/register.js',source}],links:[],events:['tool.call'],calls:[],nextTiers:[],options:{},tier:'user',fingerprint:source}
}

test('50ms real next budget settles only the aborted dispatch before heartbeat identifies resumed CPU',async()=>{
  const died=Promise.withResolvers<{error:Error;fault:ModWorkerFault}>()
  let death: {error:Error;fault:ModWorkerFault}|undefined
  const host=createModEnvironmentHost({onDied:(error,fault)=>{death={error,fault};died.resolve(death)}})
  try {
    const sibling=await host.load(declaration('survivor',`export function register(on){on('tool.call',()=>({wait:()=>new Promise(()=>{}),alive:()=>true}))}`))
    const bad=await host.load(declaration('culprit',`export function register(on){on('tool.call',async($,e,next)=>{await $.entered(next.budget.ms);for(;;){}}).catch(()=>({result:'old-catch'}))}`))
    const old=await sibling.invoke(sibling.registrations[0]!.id,[]) as {wait():Promise<unknown>;alive():Promise<boolean>}
    let siblingSettled=false
    const waiting=old.wait().catch(error=>error).finally(()=>{siblingSettled=true})
    const registration=bad.registrations[0]!,entered=Promise.withResolvers<number>()
    const bodySettled=Promise.withResolvers<{error:unknown;at:number}>()
    const start=performance.now()
    const output=dispatchModEvent({event:'tool.call',input:{},budgetMs:50,hooks:[{
      plugin:'culprit',tier:'user',registration,invoke:(input,next,catching)=>{
        const call=bad.invoke(catching?registration.catchId!:registration.id,[{entered:(ms:number)=>entered.resolve(ms)},input],next)
        if (!catching) void call.catch(error=>bodySettled.resolve({error,at:performance.now()}))
        return call
      },
    }],core:async()=>({result:'core'})})
    expect(await entered.promise).toBe(50)
    expect(await output).toEqual({result:'core'})
    expect(performance.now()-start).toBeLessThan(1500)
    const aborted=await bodySettled.promise
    expect(String(aborted.error)).toContain('did not settle')
    expect(aborted.at-start).toBeGreaterThanOrEqual(5000)
    expect(aborted.at-start).toBeLessThan(5800)
    expect(death).toBeUndefined()
    expect(siblingSettled).toBe(false)
    const actual=await died.promise
    expect(performance.now()-start).toBeGreaterThanOrEqual(5900)
    expect(performance.now()-start).toBeLessThan(7500)
    expect(actual.fault).toMatchObject({cause:'heartbeat',culprit:{plugin:'culprit',environment:bad.id,evidence:'resumed',stage:'invoke',settledRequestId:expect.any(Number)}})
    expect(actual.fault.culprit).not.toHaveProperty('requestId')
    expect(await waiting).toBe(actual.error)
    await expect(old.alive()).rejects.toThrow('unloaded')
  } finally {await host.dispose()}
},10000)

test('50ms aborted yielding dispatch expires alone without killing its responsive shared Worker',async()=>{
  let deaths=0
  const host=createModEnvironmentHost({onDied:()=>{deaths++}})
  try {
    const sibling=await host.load(declaration('survivor',`export function register(on){on('tool.call',()=>({wait:()=>new Promise(()=>{}),alive:()=>true}))}`))
    const bad=await host.load(declaration('yielding',`export function register(on){on('tool.call',async($)=>{await $.hold();return {result:'late'}})}`))
    const old=await sibling.invoke(sibling.registrations[0]!.id,[]) as {wait():Promise<unknown>;alive():Promise<boolean>}
    const waiting=old.wait().catch(error=>error)
    const settled=Promise.withResolvers<unknown>(),registration=bad.registrations[0]!
    expect(await dispatchModEvent({event:'tool.call',input:{},budgetMs:50,hooks:[{
      plugin:'yielding',tier:'user',registration,invoke:(input,next)=>{
        const call=bad.invoke(registration.id,[{hold:()=>new Promise(()=>{})},input],next)
        void call.catch(error=>settled.resolve(error));return call
      },
    }],core:async()=>({result:'core'})})).toEqual({result:'core'})
    expect(String(await settled.promise)).toContain('did not settle')
    expect(deaths).toBe(0)
    expect(await old.alive()).toBe(true)
    await host.dispose()
    expect(String(await waiting)).toContain('unloaded')
    expect(deaths).toBe(0)
  } finally {await host.dispose()}
},8000)

test('runtime 50ms AbortSignal preserves pending survivor until CPU heartbeat recovery without old catch migration',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'mods-worker-abort-overrun-')))
  const fixture=async(name:string,source:string)=>{
    const pluginRoot=await mkdtemp(join(root,name+'-')),entry=join(pluginRoot,'register.ts')
    await writeFile(entry,source);return {name,storageId:name+'@inline',pluginRoot,entrypoints:[entry]}
  }
  const bad=await fixture('culprit',`export function register(on){on('command.run',($,e,next)=>e.name==='culprit'?{text:'culprit is loaded'}:next(e));on('tool.call',async($,e,next)=>{if(e.command==='spin'){await $.clock.sleep(0);for(;;){}}return next(e)}).catch(()=>({result:'old-catch'}))}`)
  const survivor=await fixture('survivor',`let n=0;export function register(on){on('tool.call',()=>({result:++n,oldHandle:()=>n}));on('command.run',async($,e)=>{if(e.args==='hold')await $.clock.sleep(20000);return {text:'survivor'}}).catch(()=>({text:'old-survivor-catch'}))}`)
  const events:ModDiagnostic[]=[],died=Promise.withResolvers<ModDiagnostic>()
  const value=createModsRuntime({onDiagnostic:event=>{events.push(event);if(event.stage==='worker')died.resolve(event)}})
  let failure:unknown
  try {
    await value.reconcile([bad,survivor])
    const input={tool:'Bash',tool_use_id:'abort-overrun',command:'normal'}
    const first=await value.dispatch('tool.call',input,async()=>({result:'core'})) as {result:number;oldHandle():Promise<number>}
    expect(first.result).toBe(1)
    let waitingSettled=false
    const waiting=value.dispatch('command.run',{name:'hold',args:'hold'},async()=>({text:'core'})).then(value=>value,error=>error).finally(()=>{waitingSettled=true})
    await new Promise(resolve=>setTimeout(resolve,20))
    const controller=new AbortController(),reason=new Error('actual 50ms caller abort'),start=performance.now()
    const timer=setTimeout(()=>controller.abort(reason),50)
    const spinning=value.dispatch('tool.call',{...input,command:'spin'},async()=>({result:'core'}),{signal:controller.signal}).then(value=>value,error=>error)
    expect(await spinning).toBe(reason)
    expect(controller.signal.reason).toBe(reason)
    clearTimeout(timer)
    expect(performance.now()-start).toBeLessThan(500)
    await new Promise(resolve=>setTimeout(resolve,5350))
    expect(events.filter(event=>event.stage==='worker')).toHaveLength(0)
    expect(waitingSettled).toBe(false)
    const diagnostic=await died.promise
    expect(diagnostic).toMatchObject({plugin:'culprit',workerFault:{cause:'heartbeat',culprit:{storageId:'culprit@inline',evidence:'resumed',stage:'invoke',settledRequestId:expect.any(Number)}}})
    expect(diagnostic.workerFault!.culprit).not.toHaveProperty('requestId')
    expect(performance.now()-start).toBeGreaterThanOrEqual(5800)
    expect(await waiting).not.toEqual({text:'old-survivor-catch'})
    await value.bind({cwd:root,surface:null,isInteractive:false,sessionId:'abort-overrun'})
    expect(await value.dispatch('tool.call',input,async()=>({result:'core'}))).toMatchObject({result:1})
    await expect(first.oldHandle()).rejects.toThrow('unloaded')
    expect(await value.dispatch('command.run',{name:'culprit',args:''},async()=>({text:'core'}))).toEqual({text:'survivor'})
    const again=performance.now()
    expect(await value.dispatch('tool.call',{...input,command:'spin'},async()=>({result:'core'}))).toMatchObject({result:2})
    expect(performance.now()-again).toBeLessThan(500)
    expect(events.filter(event=>event.stage==='worker')).toHaveLength(1)
  } catch (error) {failure=error}
  try {await value.dispose()}
  catch (error) {failure=failure===undefined?error:new AggregateError([failure,error],'Runtime assertions and disposal both failed')}
  try {await rm(root,{recursive:true,force:true})}
  catch (error) {failure=failure===undefined?error:new AggregateError([failure,error],'Runtime assertions and fixture cleanup both failed')}
  if (failure!==undefined) throw failure
},10000)
