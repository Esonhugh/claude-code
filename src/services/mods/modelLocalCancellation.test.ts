import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModModelComplete } from './modelAdapter.js'
import { createModsRuntime } from './runtime.js'

let root: string
const runtimes: ReturnType<typeof createModsRuntime>[]=[]
beforeEach(async () => {root=await mkdtemp(join(tmpdir(),'mods-model-cancel-'))})
afterEach(async () => {await Promise.all(runtimes.splice(0).map(runtime=>runtime.dispose()));await rm(root,{recursive:true,force:true})})
const usage={input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}
const aborted={isAnswered:false,reason:'aborted',usage}
async function plugin(name:string,source:string) {
  const pluginRoot=join(root,name);await mkdir(pluginRoot)
  const entry=join(pluginRoot,'register.ts');await writeFile(entry,source)
  return {name,storageId:`${name}@test`,pluginRoot,entrypoints:[entry]}
}
async function bind(runtime:ReturnType<typeof createModsRuntime>) {
  runtimes.push(runtime);await runtime.bind({cwd:root,sessionId:'test',surface:'terminal',isInteractive:true})
}

test('already aborted plugin-local signal makes no completion request and is absent from hook input',async () => {
  const observed:unknown[]=[],calls:unknown[]=[]
  const runtime=createModsRuntime({services:{modelComplete:async request=>{calls.push(request);return {isAnswered:true,text:'wrong',usage}}}})
  await bind(runtime)
  const consumer=await plugin('consumer',`export function register(on) {
    on('tool.call',async $=>{const stop=new AbortController();stop.abort('private-reason');return {result:await $.model.complete({model:'haiku',prompt:'cold'},{signal:stop.signal})};});
  }`)
  const release=runtime.registerHostHook({plugin:'host-observer',tier:'user',registration:{id:1,event:'model.complete',hasCatch:false},invoke:async (e,next)=>{observed.push(e);return next(e)}})
  try {
    await runtime.reconcile([consumer])
    expect(await runtime.dispatch('tool.call',{},async ()=>({result:'core'}))).toEqual({result:aborted})
    expect(calls).toEqual([])
    expect(observed.every(value=>!('signal' in (value as object)))).toBe(true)
  } finally {release()}
})

test('later handler aborts only its owned call while another completion succeeds',async () => {
  const calls=new Map<string,AbortSignal|undefined>(),replies=new Map<string,()=>void>()
  const entered=Promise.withResolvers<void>()
  const runtime=createModsRuntime({services:{modelComplete:async (request,signal)=>{
    calls.set(request.prompt,signal)
    if(calls.size===2)entered.resolve()
    await new Promise<void>((resolve,reject)=>{
      replies.set(request.prompt,resolve)
      if(signal?.aborted)reject(new Error('aborted'))
      else signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})
    })
    return {isAnswered:true,text:request.prompt,usage}
  }}})
  await bind(runtime)
  const consumer=await plugin('consumer',`let stop;export function register(on) {
    on('tool.call',async ($,e)=>{
      if(e.action==='cancel'){stop.abort('private-reason');return {result:'cancelled'};}
      stop=new AbortController();const other=new AbortController();
      return {result:await Promise.all([
        $.model.complete({model:'haiku',prompt:'cancel-me'},{signal:stop.signal}),
        $.model.complete({model:'haiku',prompt:'keep-me'},{signal:other.signal}),
      ])};
    });
  }`)
  await runtime.reconcile([consumer])
  const pending=runtime.dispatch('tool.call',{action:'start'},async ()=>({result:'core'}))
  try {
    await entered.promise
    expect(await runtime.dispatch('tool.call',{action:'cancel'},async ()=>({result:'core'}))).toEqual({result:'cancelled'})
    expect(calls.get('keep-me')?.aborted).toBe(false)
    replies.get('keep-me')!()
    expect(await pending).toEqual({result:[aborted,{isAnswered:true,text:'keep-me',usage}]})
    expect(calls.get('cancel-me')?.aborted).toBe(true)
  } finally {for(const reply of replies.values())reply();await pending.catch(()=>{})}
})

// Official 292 p5t starts its deadline after model.complete middleware.
test('completion deadline leaves delayed model middleware under its own hook budget',async () => {
  let calls=0
  const runtime=createModsRuntime({services:{modelComplete:async ()=>{calls++;return {isAnswered:true,text:'after middleware',usage}}}})
  await bind(runtime)
  const consumer=await plugin('consumer',`export function register(on) {
    on('tool.call',async $=>({result:await $.model.complete({model:'haiku',prompt:'slow',timeoutMs:10})}));
  }`)
  const policy=await plugin('policy',`export function register(on) {
    on('model.complete',async ($,e,next)=>{await $.clock.sleep(100);return next(e);});
  }`)
  await runtime.reconcile([consumer,policy])
  expect(await runtime.dispatch('tool.call',{},async ()=>({result:'core'}))).toEqual({result:{isAnswered:true,text:'after middleware',usage}})
  expect(calls).toBe(1)
})

test('local cancellation is fenced to its Worker environment',async()=>{
  const entered=Promise.withResolvers<void>()
  const signals=new Map<string,AbortSignal|undefined>(),replies=new Map<string,()=>void>()
  const runtime=createModsRuntime({services:{modelComplete:async(request,signal)=>{
    signals.set(request.prompt,signal)
    if(signals.size===2)entered.resolve()
    await new Promise<void>((resolve,reject)=>{
      replies.set(request.prompt,resolve)
      signal?.addEventListener('abort',()=>reject(signal.reason),{once:true})
    })
    return {isAnswered:true,text:request.prompt,usage}
  }}})
  await bind(runtime)
  const sources=await Promise.all(['first','second'].map(name=>plugin(name,`let stop;export function register(on){
    on('tool.call',async($,e,next)=>{
      if(e.owner!=='${name}')return next(e);
      if(e.action==='cancel'){stop.abort();return {result:'cancelled'};}
      stop=new AbortController();return {result:await $.model.complete({model:'haiku',prompt:'${name}'},{signal:stop.signal})};
    });
  }`)))
  await runtime.reconcile(sources)
  const first=runtime.dispatch('tool.call',{owner:'first'},async()=>({result:'core'}))
  const second=runtime.dispatch('tool.call',{owner:'second'},async()=>({result:'core'}))
  try{
    await entered.promise
    await runtime.dispatch('tool.call',{owner:'first',action:'cancel'},async()=>({result:'core'}))
    expect(await first).toEqual({result:aborted})
    expect(signals.get('first')?.aborted).toBe(true)
    expect(signals.get('second')?.aborted).toBe(false)
    replies.get('second')!()
    expect(await second).toEqual({result:{isAnswered:true,text:'second',usage}})
  }finally{
    for(const reply of replies.values())reply()
    await Promise.allSettled([first,second])
  }
})

test('a completed local signal is detached and cannot cancel a later call',async()=>{
  const signals:AbortSignal[]=[]
  const runtime=createModsRuntime({services:{modelComplete:async(request,signal)=>{
    signals.push(signal!)
    return {isAnswered:true,text:request.prompt,usage}
  }}})
  await bind(runtime)
  const consumer=await plugin('consumer',`export function register(on){
    on('tool.call',async $=>{
      const stop=new AbortController();let attached=0,detached=0;
      const signal={get aborted(){return stop.signal.aborted},addEventListener(...args){attached++;stop.signal.addEventListener(...args)},removeEventListener(...args){detached++;stop.signal.removeEventListener(...args)}};
      const first=await $.model.complete({model:'haiku',prompt:'first'},{signal});
      stop.abort();const second=await $.model.complete({model:'haiku',prompt:'second'});
      return {result:{first,second,attached,detached}};
    });
  }`)
  await runtime.reconcile([consumer])
  expect(await runtime.dispatch('tool.call',{},async()=>({result:'core'}))).toEqual({result:{
    first:{isAnswered:true,text:'first',usage},second:{isAnswered:true,text:'second',usage},attached:1,detached:1,
  }})
  expect(signals.every(signal=>!signal.aborted)).toBe(true)
})


test('core cancellation keeps its mutable receipt while provider teardown completes', async () => {
  const entered = Promise.withResolvers<void>()
  let closed = false
  const complete = createModModelComplete(async options => {
    entered.resolve()
    try {
      await new Promise<void>((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {once:true}))
      return { content: [] }
    } finally { closed = true }
  }, model => model)
  const runtime = createModsRuntime({services:{modelComplete:complete}})
  await bind(runtime)
  const consumer = await plugin('consumer', `let stop;export function register(on){
    on('tool.call',async($,e)=>{
      if(e.action==='cancel'){stop.abort(new Error('OWNED_CANCEL'));return {result:'cancelled'}}
      stop=new AbortController();const result=await $.model.complete({model:'haiku',prompt:'held'},{signal:stop.signal});
      return {result:{value:result,frozen:Object.isFrozen(result),usageFrozen:Object.isFrozen(result.usage)}};
    });
  }`)
  const policy = await plugin('policy', `export function register(on){on('model.complete',async($,e,next)=>next(e))}`)
  await runtime.reconcile([consumer,policy])
  const pending = runtime.dispatch('tool.call',{},async()=>({result:'core'}))
  await entered.promise
  await runtime.dispatch('tool.call',{action:'cancel'},async()=>({result:'core'}))
  expect(await pending).toEqual({result:{value:aborted,frozen:false,usageFrozen:false}})
  expect(closed).toBe(true)
})

test('hook cancellation carries its reason, permits final debug logging and returns the frozen author receipt', async () => {
  const entered = Promise.withResolvers<void>()
  const logs: string[] = []
  let calls = 0
  const runtime = createModsRuntime({services:{
    modelComplete:async()=>{calls++;return {isAnswered:true,text:'unexpected',usage}},
    uiLog:(_plugin,text)=>{logs.push(text);if(text==='entered')entered.resolve()},
  }})
  await bind(runtime)
  const consumer = await plugin('consumer', `let stop;export function register(on){
    on('tool.call',async($,e)=>{
      if(e.action==='cancel'){stop.abort(new Error('OWNED_CANCEL'));return {result:'cancelled'}}
      stop=new AbortController();const result=await $.model.complete({model:'haiku',prompt:'held'},{signal:stop.signal});
      return {result:{value:result,frozen:Object.isFrozen(result),usageFrozen:Object.isFrozen(result.usage)}};
    });
  }`)
  const policy = await plugin('policy', `export function register(on){
    on('model.complete',async($,e,next)=>{
      $.ui.log('entered',{to:'debug'});
      try{await $.clock.sleep(1000);return await next(e)}
      catch(error){const reason=next.signal.reason;$.ui.log(JSON.stringify({aborted:next.signal.aborted,name:reason.name,message:reason.message}),{to:'debug'});throw error}
    });
  }`)
  await runtime.reconcile([consumer,policy])
  const pending = runtime.dispatch('tool.call',{},async()=>({result:'core'}))
  await entered.promise
  await runtime.dispatch('tool.call',{action:'cancel'},async()=>({result:'core'}))
  expect(await pending).toEqual({result:{value:aborted,frozen:true,usageFrozen:true}})
  await runtime.settle()
  expect(logs).toEqual(['entered',JSON.stringify({aborted:true,name:'HooksError',message:'OWNED_CANCEL'})])
  expect(calls).toBe(0)
})
