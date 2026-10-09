import { expect, test } from 'bun:test'
import { createModEnvironmentHost } from './environment.js'
import type { ModWorkerFault } from './protocol.js'
import type { ModDeclaration } from './types.js'

function declaration(name:string,source:string):ModDeclaration {
  return {name,storageId:name+'@inline',pluginRoot:'/fixture',entrypoints:['/fixture/register.js'],modules:[{path:'/fixture/register.js',source}],links:[],events:['tool.call'],calls:[],nextTiers:[],options:{},tier:'user',fingerprint:source}
}

test.each(['sync','after-host-await'])('real web timer %s CPU is a callback rather than a settled registration invocation',async mode=>{
  const died=Promise.withResolvers<ModWorkerFault>()
  const host=createModEnvironmentHost({onDied:(_error,fault)=>died.resolve(fault)})
  try {
    const sibling=await host.load(declaration('survivor',`export function register(on){on('tool.call',()=>new Promise(()=>{}))}`))
    const bad=await host.load(declaration('timer',`export function register(on){on('tool.call',($)=>{AbortSignal.timeout(20).addEventListener('abort',${mode==='sync'?'':'async '}()=>{${mode==='sync'?'':'await $.entered();'}for(;;){}});return {ready:true}})}`))
    const pending=sibling.invoke(sibling.registrations[0]!.id,[]).catch(error=>error)
    expect(await bad.invoke(bad.registrations[0]!.id,[{entered:()=>true}])).toEqual({ready:true})
    const fault=await died.promise
    expect(fault).toMatchObject({cause:'heartbeat',culprit:{environment:bad.id,plugin:'timer',evidence:mode==='sync'?'stack':'resumed',stage:'callback'}})
    expect(fault.culprit).not.toHaveProperty('requestId')
    expect(fault.culprit).not.toHaveProperty('settledRequestId')
    expect(String(await pending)).toContain('heartbeat')
  } finally {await host.dispose()}
},10000)
