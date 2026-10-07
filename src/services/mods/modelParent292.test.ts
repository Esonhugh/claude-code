import {afterEach,beforeEach,expect,test} from 'bun:test'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createModsRuntime} from './runtime.js'
import {createModModelComplete} from './modelAdapter.js'
import native from './fixtures/modelParent292.json'
let root:string;const runtimes:ReturnType<typeof createModsRuntime>[]=[]
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'model-parent-292-'))})
afterEach(async()=>{await Promise.all(runtimes.splice(0).map(r=>r.dispose()));await rm(root,{recursive:true,force:true})})
const usage={input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}
async function plugin(name:string,source:string){const pluginRoot=join(root,name);await mkdir(pluginRoot);const entry=join(pluginRoot,'register.mjs');await writeFile(entry,source);return {name,storageId:name+'@test',pluginRoot,entrypoints:[entry]}}

test.each(['complete','classify','fork'] as const)('292 model.%s keeps parent core cancellation separate from hook cancellation',async method=>{
 for(const stage of ['http','hook']as const){
  const entered=Promise.withResolvers<void>(),logs:string[]=[];let cores=0,closed=false
  const complete=createModModelComplete(async({signal})=>{cores++;entered.resolve();try{await new Promise<void>((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true}));return {content:[]}}finally{closed=true}},x=>x,()=>8192,'owned-parent-owner')
  const fork=async(_request:unknown,signal?:AbortSignal)=>{cores++;entered.resolve();await new Promise<void>(resolve=>signal!.addEventListener('abort',()=>resolve(),{once:true}));closed=true;return {isAnswered:false as const,reason:'aborted' as const,usage}}
  const runtime=createModsRuntime({services:{modelComplete:complete,modelFork:fork,uiLog:(_plugin,text)=>{logs.push(text);if(text==='blocked')entered.resolve()}}});runtimes.push(runtime)
  await runtime.bind({cwd:root,sessionId:'owned-'+method+'-'+stage,surface:'terminal',isInteractive:true})
  const call=method==='complete'?`$.model.complete({model:'haiku',prompt:'held'})`:method==='classify'?`$.model.classify('held',['YES','NO'],{model:'haiku'})`:`$.model.fork({prompt:'held'})`
  const owner=await plugin('owned-parent-owner-'+stage,`let outcome;export function register(on){on('turn.step',async function*($,e,next){try{const result=await ${call};outcome={phase:'parent-result',result,frozen:Object.isFrozen(result),usageFrozen:Boolean(result&&result.usage&&Object.isFrozen(result.usage))}}catch(error){outcome={phase:'parent-error',kind:error.name,message:error.message}}finally{const reason=next.signal.reason;$.ui.log(JSON.stringify({...outcome,aborted:next.signal.aborted,reason:{name:reason?.name,message:reason?.message}}),{to:'debug'})}return yield*next(e)})}`)
  // Keep the provider's canonical plugin name in this test, matching native evidence.
  owner.name='owned-parent-owner';owner.storageId='owned-parent-owner@test'
  const other=await plugin('owned-parent-other-'+stage,`export function register(on){on('model.${method}',async($,e,next)=>{try{${stage==='hook'?`$.ui.log('blocked',{to:'debug'});await $.clock.sleep(3000);`:''}return await next(e)}catch(error){$.ui.log(JSON.stringify({phase:'model-caught',name:next.signal.reason?.name,message:next.signal.reason?.message}),{to:'debug'});throw error}})}`)
  await runtime.reconcile([owner,other]);const stop=new AbortController()
  const stream=runtime.stream('turn.step',{turnId:'owned',index:0,model:'haiku',messageCount:1},async function*(){yield {kind:'text',index:0,text:'unexpected'};return {turnId:'owned',index:0,answer:'',toolUses:[],stopReason:'end_turn',usage:null}},{signal:stop.signal})
  const pull=stream.next().catch(error=>error);const result=stream.result.catch(error=>error)
  await entered.promise;stop.abort('user-cancel');await pull;await result;await stream.return(undefined)
  const receipt=logs.filter(x=>x.startsWith('{')).map(x=>JSON.parse(x)).find(x=>x.phase.startsWith('parent-'))
  const scenario=method+'-'+stage,expected=native.events.find(e=>e.scenario===scenario&&(e.phase==='parent-result'||e.phase==='parent-error'))!
  expect(receipt.phase).toBe(expected.phase);expect(receipt.aborted).toBe(true);expect(receipt.reason).toEqual({name:'HooksError',message:'user-cancel'})
  if('result'in expected){expect(receipt.result).toEqual({isAnswered:false,reason:'aborted',usage});expect(receipt.frozen).toBe(false);expect(receipt.usageFrozen).toBe(false)}
  else expect({kind:receipt.kind,message:receipt.message}).toEqual({kind:expected.kind,message:expected.message})
  expect(cores).toBe(stage==='http'?1:0);expect(closed).toBe(stage==='http')
  expect(logs.filter(x=>x.includes('model-caught')).length).toBe(stage==='hook'||method==='classify'?1:0)
  expect(await runtime.dispatch('tool.call',{},async()=>({result:'recovered'}))).toEqual({result:'recovered'})
 }
})
