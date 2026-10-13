// Isolated source child only: SDK payload transport is an in-memory stub, never remote network evidence.
import {afterAll,afterEach,beforeEach,expect,mock,spyOn,test} from 'bun:test'
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

if(process.env.OWNED_FILL_FLAG_CHILD==='1')await registerChildTests()
else test('isolated cached flags payload and real Worker fill source child exits with all original assertions',async()=>{
 const owned=await mkdtemp(join(tmpdir(),'owned-fill-flag-child-'));for(const folder of ['home','config','tmp'])await mkdir(join(owned,folder))
 try{
  const child=Bun.spawn([process.execPath,'test',import.meta.file],{cwd:process.cwd(),env:{PATH:process.env.PATH,HOME:join(owned,'home'),CLAUDE_CONFIG_DIR:join(owned,'config'),TMPDIR:join(owned,'tmp'),LANG:'en_US.UTF-8',NODE_ENV:'test',BUN_RUNTIME_TRANSPILER_CACHE_PATH:'0',OWNED_FILL_FLAG_CHILD:'1'},stdout:'pipe',stderr:'pipe',timeout:30000})
  const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()])
  if(exit!==0)throw Error(stdout+'\n'+stderr)
  expect(exit).toBe(0);expect(stdout).toContain('OWNED_FILL_FLAG_CHILD_SETTLED');expect(stderr).toContain('11 pass');expect(stderr).toContain('0 fail')
  console.log(JSON.stringify({owned_child_pid:child.pid,exit_code:exit,source_only:true,native_started:false,stdout,stderr}))
 }finally{await rm(owned,{recursive:true,force:true})}
},35000)
async function registerChildTests(){
let payload:{features:{[key:string]:{value:unknown}}}={features:{}}
let payloadProcessed=0,initCalls=0
mock.module('@growthbook/growthbook',()=>({GrowthBook:class{
 async init(){initCalls++;return{source:'owned-memory-transport',success:true}}
 getPayload(){return payload}
 async setPayload(next:typeof payload){payload=next;payloadProcessed++}
 getFeatures(){return payload.features}
 destroy(){}
}}))
const flag=await import('../analytics/growthbook.js')
const analytics=await import('../analytics/firstPartyEventLogger.js')
const http=await import('../../utils/http.js')
const user=await import('../../utils/user.js')
const config=await import('../../utils/config.js')
const bootstrap=await import('../../bootstrap/state.js')
const {createModsRuntime}=await import('./runtime.js')
let root:string
let enabled:ReturnType<typeof spyOn>,auth:ReturnType<typeof spyOn>,identity:ReturnType<typeof spyOn>
const runtimes:ReturnType<typeof createModsRuntime>[]=[]
beforeEach(async()=>{
 root=await mkdtemp(join(tmpdir(),'owned-fill-flag-'));flag.resetGrowthBook();payloadProcessed=0;initCalls=0
 enabled=spyOn(analytics,'is1PEventLoggingEnabled').mockReturnValue(true)
 auth=spyOn(http,'getAuthHeaders').mockReturnValue({headers:{'x-api-key':'owned-dummy-not-a-credential'}})
 identity=spyOn(user,'getUserForGrowthBook').mockReturnValue({deviceId:'owned-source',sessionId:'owned-source',platform:'darwin',appVersion:'0.0.0-owned-source'})
 bootstrap.setSessionTrustAccepted(true)
 config.saveGlobalConfig(c=>({...c,cachedGrowthBookFeatures:{}}))
})
afterEach(async()=>{
 await Promise.all(runtimes.splice(0).map(r=>r.dispose()));flag.resetGrowthBook();enabled.mockRestore();auth.mockRestore();identity.mockRestore();bootstrap.setSessionTrustAccepted(false)
 config.saveGlobalConfig(c=>({...c,cachedGrowthBookFeatures:{}}));await rm(root,{recursive:true,force:true})
})
const KEY='tengu_tranquil_cloud'
test.each([
 ['payload false',{[KEY]:{value:false}},{[KEY]:true},false],
 ['payload true',{[KEY]:{value:true}},{[KEY]:false},true],
 ['payload null',{[KEY]:{value:null}},{[KEY]:false},true],
 ['payload missing key',{other_owned:{value:false}},{[KEY]:false},true],
] as const)('real payload processor and cached getter: %s',async(_label,features,disk,expected)=>{
 payload={features:{...features}};await flag.initializeGrowthBook()
 expect(initCalls).toBe(1);expect(payloadProcessed).toBe(1)
 // Controlled stale test-cache value is written AFTER real payload handling to expose fallback precedence.
 config.saveGlobalConfig(c=>({...c,cachedGrowthBookFeatures:{...disk}}))
 expect(flag.getFeatureValue_CACHED_MAY_BE_STALE(KEY,true)).toBe(expected)
})
test.each([
 ['disk false',{[KEY]:false},false],['disk true',{[KEY]:true},true],['disk null',{[KEY]:null},true],['disk missing',{},true],
] as const)('cached getter with no payload: %s',(_label,disk,expected)=>{
 config.saveGlobalConfig(c=>({...c,cachedGrowthBookFeatures:{...disk}}))
 expect(flag.getFeatureValue_CACHED_MAY_BE_STALE(KEY,true)).toBe(expected)
 expect(initCalls).toBe(0);expect(payloadProcessed).toBe(0)
})
test('disabled analytics retains privacy default and does not read cached false',()=>{
 enabled.mockReturnValue(false);config.saveGlobalConfig(c=>({...c,cachedGrowthBookFeatures:{[KEY]:false}}))
 expect(flag.getFeatureValue_CACHED_MAY_BE_STALE(KEY,true)).toBe(true)
})
test.each(['disk','payload'] as const)('real public Worker fill reads standard %s false and preserves raw rewritten text and ranges',async source=>{
 if(source==='payload'){
  payload={features:{[KEY]:{value:false}}};await flag.initializeGrowthBook()
  expect(initCalls).toBe(1);expect(payloadProcessed).toBe(1)
 }else config.saveGlobalConfig(c=>({...c,cachedGrowthBookFeatures:{[KEY]:false}}))
 expect(flag.getFeatureValue_CACHED_MAY_BE_STALE(KEY,true)).toBe(false)
 const pluginRoot=join(root,'caller');await mkdir(pluginRoot);const entry=join(pluginRoot,'register.ts')
 const raw='A\u200B😀\r\nB\uD800C',decorations=[{start:2,end:4,bold:true}]
 await writeFile(entry,`export function register(on){on('tool.call',async($,e)=>{await $.prompt.read();return {result:await $.prompt.fill({text:e.text,decorations:e.decorations})}});on('prompt.fill',($,e,next)=>next({...e,text:e.text+'!'}));}`)
 let box={text:'',cursor:0};const inputs:unknown[]=[],diagnostics:unknown[]=[]
 const runtime=createModsRuntime({onDiagnostic:d=>diagnostics.push(d),services:{prompt:()=>({read:()=>({...box}),fill:input=>{inputs.push(structuredClone(input));box={text:input.text,cursor:input.text.length};return true}})}})
 runtimes.push(runtime);await runtime.bind({cwd:root,sessionId:'owned-flag',surface:'terminal',isInteractive:true});await runtime.reconcile([{name:'caller',storageId:'caller@owned',pluginRoot,entrypoints:[entry]}])
 expect(await runtime.dispatch('tool.call',{text:raw,decorations},async()=>({result:'unexpected core'}))).toEqual({result:{isFilled:true,text:raw+'!',cursor:raw.length+1}})
 expect(inputs).toEqual([{text:raw+'!',decorations,mode:'replace',origin:{kind:'plugin',name:'caller'}}]);expect(diagnostics).toEqual([])
})

afterAll(()=>console.log('OWNED_FILL_FLAG_CHILD_SETTLED'))
}
