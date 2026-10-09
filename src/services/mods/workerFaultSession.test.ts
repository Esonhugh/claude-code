import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LoadedPlugin } from '../../types/plugin.js'
import * as debug from '../../utils/debug.js'
import * as secureStorage from '../../utils/secureStorage/index.js'
import { clearPluginOptionsCache } from '../../utils/plugins/pluginOptionsStorage.js'
import { createModsRuntime, type ModDiagnostic } from './runtime.js'
import { createModsSession } from './session.js'

test('actual session debug logger retains structured heartbeat and settled invocation fields without input or sensitive options',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mods-worker-fault-session-'))
  const fixture=async(name:string,source:string):Promise<LoadedPlugin>=>{
    const path=await mkdtemp(join(root,name+'-'))
    await writeFile(join(path,'register.ts'),source)
    return {name,manifest:{name},path,source:name+'@inline',repository:name+'@inline',enabled:true,hookModules:[{configPath:join(path,'hooks.json'),paths:['./register.ts']}]}
  }
  const bad=await fixture('culprit',`export function register(on){on('tool.call',async($,e,next)=>{if(e.command==='spin'){await $.clock.sleep(0);for(;;){}}return next(e)})}`)
  bad.manifest.userConfig={token:{type:'string',title:'Token',description:'',sensitive:true,required:true}}
  const survivor=await fixture('survivor',`export function register(on){on('command.run',async($)=>{await $.clock.sleep(20000);return {text:'late'}})}`)
  const secret='dummy-worker-fault-sensitive-option',inputBody='dummy-private-prompt-input'
  const storage=spyOn(secureStorage,'getSecureStorage').mockReturnValue({read:()=>({pluginSecrets:{'culprit@inline':{token:secret}}}),update:()=>{throw Error('unexpected storage write')}} as unknown as ReturnType<typeof secureStorage.getSecureStorage>)
  clearPluginOptionsCache()
  const logs:string[]=[],logging=spyOn(debug,'logForDebugging').mockImplementation(value=>{logs.push(value)})
  const died=Promise.withResolvers<ModDiagnostic>()
  const host=createModsSession({isTrusted:true,getSettings:()=>({userSettings:null,flagSettings:null,policySettings:null,hookPolicy:{managedOnly:false,allDisabled:false}}),loadPlugins:async()=>[bad,survivor],
    createRuntime:options=>createModsRuntime({...options,onDiagnostic:event=>{
      const fault=event.workerFault
      // Real CPU fault fields plus disallowed dummy metadata at the logger boundary.
      const augmented=fault?{...fault,input:inputBody,options:{token:secret},privateKey:'dummy-private-key',culprit:fault.culprit?{...fault.culprit,storageId:fault.culprit.storageId+':'+secret}:undefined}:undefined
      options.onDiagnostic?.({...event,...(augmented&&{workerFault:augmented})})
    }}),onDiagnostic:event=>{if(event.stage==='worker')died.resolve(event)}})
  let failure:unknown
  try {
    await host.bind({cwd:root,surface:null,isInteractive:false,sessionId:'worker-fault'})
    const waiting=host.runtime!.dispatch('command.run',{name:'hold',args:''},async()=>({text:'core'})).catch(error=>error)
    await new Promise(resolve=>setTimeout(resolve,20))
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),50)
    expect(await host.runtime!.dispatch('tool.call',{tool:'Bash',tool_use_id:'worker-fault',command:'spin',privateBody:inputBody},async()=>({result:'core'}),{signal:controller.signal}).catch(error=>error)).toMatchObject({name:'AbortError'})
    clearTimeout(timer)
    const event=await died.promise
    await waiting
    expect(event.workerFault).toMatchObject({cause:'heartbeat',culprit:{plugin:'culprit',evidence:'resumed'}})
    const text=logs.find(text=>text.includes('workerFault='))
    expect(text).toBeDefined()
    const fault=JSON.parse(text!.slice(text!.indexOf('workerFault=')+'workerFault='.length))
    expect(fault).toMatchObject({cause:'heartbeat',workerAgeMs:expect.any(Number),pendingRequests:expect.any(Number),pingAgeMs:expect.any(Number),culprit:{plugin:'culprit',storageId:'culprit@inline:[REDACTED]',evidence:'resumed',stage:'invoke',settledRequestId:expect.any(Number)}})
    expect(fault.culprit).not.toHaveProperty('requestId')
    expect(logs.join('\n')).not.toContain(secret)
    expect(logs.join('\n')).not.toContain(inputBody)
    expect(fault).not.toHaveProperty('options')
    expect(fault).not.toHaveProperty('input')
    expect(fault).not.toHaveProperty('privateKey')
  } catch(error) {failure=error}
  try {await host.dispose()} catch(error) {failure=failure===undefined?error:new AggregateError([failure,error],'Session assertion and disposal failed')}
  logging.mockRestore();storage.mockRestore();clearPluginOptionsCache()
  try {await rm(root,{recursive:true,force:true})} catch(error) {failure=failure===undefined?error:new AggregateError([failure,error],'Session assertion and fixture cleanup failed')}
  if(failure!==undefined)throw failure
},10000)

test('actual session logs each unowned Worker death even when its message is unchanged',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mods-worker-repeated-fault-'))
  await writeFile(join(root,'register.ts'),`export function register(on){on('tool.call',()=>({result:'alive'}))}`)
  const plugin:LoadedPlugin={name:'fixture',manifest:{name:'fixture'},path:root,source:'fixture@inline',repository:'fixture@inline',enabled:true,hookModules:[{configPath:join(root,'hooks.json'),paths:['./register.ts']}]}
  const storage=spyOn(secureStorage,'getSecureStorage').mockReturnValue({read:()=>({}),update:()=>{throw Error('unexpected storage write')}} as unknown as ReturnType<typeof secureStorage.getSecureStorage>)
  const logs:string[]=[],events:ModDiagnostic[]=[]
  const logging=spyOn(debug,'logForDebugging').mockImplementation(value=>{logs.push(value)})
  const RealWorker=globalThis.Worker,workers:Worker[]=[]
  globalThis.Worker=class extends RealWorker {constructor(url:string|URL,options?:WorkerOptions){super(url,options);workers.push(this)}} as typeof Worker
  const host=createModsSession({isTrusted:true,getSettings:()=>({userSettings:null,flagSettings:null,policySettings:null,hookPolicy:{managedOnly:false,allDisabled:false}}),loadPlugins:async()=>[plugin],onDiagnostic:event=>{if(event.stage==='worker')events.push(event)}})
  let failure:unknown
  try {
    await host.bind({cwd:root,surface:null,isInteractive:false,sessionId:'repeated-worker-fault'})
    for(let count=1;count<=2;count++){
      expect(await host.runtime!.dispatch('tool.call',{tool:'Bash',tool_use_id:'same'},async()=>({result:'core'}))).toEqual({result:'alive'})
      workers.at(-1)!.terminate()
      const deadline=performance.now()+500
      while(events.length<count&&performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10))
      expect(events).toHaveLength(count)
      await host.runtime!.bind({cwd:root,surface:null,isInteractive:false,sessionId:'repeated-worker-fault'})
    }
    expect(logs.filter(text=>text.includes('workerFault='))).toHaveLength(2)
    for(const text of logs.filter(text=>text.includes('workerFault='))){
      const fault=JSON.parse(text.slice(text.indexOf('workerFault=')+'workerFault='.length))
      expect(fault).toMatchObject({cause:'exit',workerAgeMs:expect.any(Number),pendingRequests:expect.any(Number)})
      expect(fault).not.toHaveProperty('culprit')
    }
  } catch(error){failure=error}
  try {await host.dispose()} catch(error){failure=failure===undefined?error:new AggregateError([failure,error],'Repeated fault assertions and disposal failed')}
  globalThis.Worker=RealWorker;logging.mockRestore();storage.mockRestore();clearPluginOptionsCache()
  try {await rm(root,{recursive:true,force:true})} catch(error){failure=failure===undefined?error:new AggregateError([failure,error],'Repeated fault assertions and fixture cleanup failed')}
  if(failure!==undefined)throw failure
})
