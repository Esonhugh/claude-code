import {afterEach, beforeEach, expect, test} from 'bun:test'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {createModsRuntime} from './runtime.js'
import {dispatchModEvent, getModCapabilitySignal} from './dispatch.js'
import type {ModNext} from './types.js'

let root:string
const runtimes:ReturnType<typeof createModsRuntime>[]=[]
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'mods-background-'))})
afterEach(async()=>{await Promise.all(runtimes.splice(0).map(value=>value.dispose()));await rm(root,{recursive:true,force:true})})

async function setup(body:string,catchBody?:string) {
  const pluginRoot=join(root,'background');await mkdir(pluginRoot)
  const entry=join(pluginRoot,'register.ts')
  await writeFile(entry,`export function register(on) {
    on('tool.call',async($,e,next)=> {
      $.store.get('background').then(()=>$.ui.open({id:'background',title:'Background'})).catch(()=>{});
      ${body}
    })${catchBody?`.catch(async($,e,next)=>{${catchBody}})`:''};
  }`)
  const diagnostics:unknown[]=[]
  const value=createModsRuntime({onDiagnostic:event=>diagnostics.push(event),services:{
    uiPresentation:()=>({columns:144,rows:40,isFullscreen:true,composerEmpty:true,hasDialog:false,keyboardOwned:false}),
  }})
  runtimes.push(value)
  await value.bind({cwd:root,sessionId:'background-test',surface:'terminal',isInteractive:true})
  await value.reconcile([{name:'background',storageId:'background@test',pluginRoot,entrypoints:[entry]}])
  expect(diagnostics).toEqual([])
  const started=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),errors:unknown[]=[]
  value.registerHostHook({plugin:'delay-store',tier:'prepend',registration:{id:77,event:'store.get',hasCatch:false},
    invoke:async(input,next)=>{started.resolve();try{await release.promise;return await next(input)}catch(error){errors.push(error);throw error}},
  })
  return {value,diagnostics,started,release,errors}
}

test('real Worker detached store operation survives a successful normal hook finish',async()=>{
  const {value,diagnostics,started,release,errors}=await setup('return next(e)')
  const opened=Promise.withResolvers<void>()
  const unsubscribe=value.ui.subscribe(()=>{if(value.ui.getSnapshot().some(pane=>pane.visible))opened.resolve()})
  const timeout=setTimeout(()=>opened.reject(Error(JSON.stringify({diagnostics,errors:errors.map(error=>String(error))}))),2000)
  const call=value.dispatch('tool.call',{tool:'Write'},async()=>({result:'written'}))
  await started.promise
  expect(await call).toEqual({result:'written'})
  release.resolve();try{await opened.promise}finally{clearTimeout(timeout);unsubscribe()}
  expect(diagnostics).toEqual([])
  expect(value.ui.getSnapshot().map(({id,visible,placement,bodyColumns})=>({id,visible,placement,bodyColumns}))).toEqual([expect.objectContaining({id:'background',visible:true})])
})

test('settle waits for a started detached store operation after its hook receipt',async()=>{
  const {value,started,release}=await setup('return next(e)')
  const call=value.dispatch('tool.call',{tool:'Write'},async()=>({result:'written'}))
  await started.promise;await call
  let settled=false
  const pending=value.settle().then(()=>{settled=true})
  try{await delay(10);expect(settled).toBe(false)}finally{release.resolve();await pending}
  expect(value.ui.getSnapshot().map(pane=>pane.id)).toEqual(['background'])
})

test('settle ignores an idle periodic timer while still draining the detached store result',async()=>{
  const {value,started,release}=await setup("$.clock.every(3600000,()=>{});return next(e)")
  const call=value.dispatch('tool.call',{tool:'Write'},async()=>({result:'written'}))
  await started.promise;await call;release.resolve()
  await Promise.race([value.settle(),delay(500).then(()=>{throw Error('idle clock prevented settling')})])
  expect(value.ui.getSnapshot().map(pane=>pane.id)).toEqual(['background'])
})

test('a throwing hook does not leave its started background operation able to publish UI',async()=>{
  const {value,started,release}=await setup('throw Error("background hook failed")')
  const call=value.dispatch('tool.call',{tool:'Write'},async()=>({result:'core recovery'}))
  await started.promise
  expect(await call).toEqual({result:'core recovery'})
  release.resolve();await value.settle()
  expect(value.ui.getSnapshot()).toEqual([])
})

test('a recovered catch has its own live background operation after the failed operation aborts',async()=>{
  const {value,started,release}=await setup('throw Error("background hook failed")',`$.store.get('caught').then(()=>$.ui.open({id:'caught',title:'Caught'})).catch(()=>{});return next(e)`)
  const opened=Promise.withResolvers<void>()
  const unsubscribe=value.ui.subscribe(()=>{if(value.ui.getSnapshot().some(pane=>pane.id==='caught'&&pane.visible))opened.resolve()})
  const timeout=setTimeout(()=>opened.reject(Error('catch background did not open')),2000)
  const call=value.dispatch('tool.call',{tool:'Write'},async()=>({result:'core recovery'}))
  await started.promise;expect(await call).toEqual({result:'core recovery'})
  release.resolve();try{await opened.promise}finally{clearTimeout(timeout);unsubscribe()}
  expect(value.ui.getSnapshot().map(pane=>pane.id)).toEqual(['caught'])
})

test('caller cancellation still aborts detached store work started while the hook is active',async()=>{
  const {value,started,release}=await setup('return next(e)')
  const cancellation=new AbortController(),core=Promise.withResolvers<void>()
  const call=value.dispatch('tool.call',{tool:'Write'},async()=>{await core.promise;return {result:'written'}},{signal:cancellation.signal})
  await started.promise
  cancellation.abort(Error('person cancelled'))
  await expect(call).rejects.toThrow()
  expect(cancellation.signal.reason.message).toBe('person cancelled')
  core.resolve();release.resolve();await value.settle()
  expect(value.ui.getSnapshot()).toEqual([])
})

test('retiring an owner prevents its detached completion from issuing a new UI call',async()=>{
  const {value,started,release}=await setup('return next(e)')
  const call=value.dispatch('tool.call',{tool:'Write'},async()=>({result:'written'}))
  await started.promise;await call
  await value.reconcile([])
  release.resolve();await value.settle()
  expect(value.ui.getSnapshot()).toEqual([])
})

test('runtime disposal aborts outstanding detached capability work',async()=>{
  const {value,started,release}=await setup('return next(e)')
  const call=value.dispatch('tool.call',{tool:'Write'},async()=>({result:'written'}))
  await started.promise;await call
  const disposal=value.dispose()
  release.resolve();await disposal
  expect(value.ui.getSnapshot()).toEqual([])
})

test('normal completion expires next while its started operation still follows a later real parent cancellation',async()=>{
  const parent=new AbortController();let captured:ModNext
  await dispatchModEvent({event:'tool.call',input:{},signal:parent.signal,hooks:[{
    plugin:'normal',tier:'user',registration:{id:1,event:'tool.call',hasCatch:false},
    invoke:async(e,next)=>{captured=next;return next(e)},
  }],core:async()=>({result:'done'})})
  expect(captured!.signal.aborted).toBe(true)
  expect(getModCapabilitySignal(captured!).aborted).toBe(false)
  await expect(captured!({})).rejects.toThrow()
  parent.abort(Error('later real cancellation'))
  expect(getModCapabilitySignal(captured!).aborted).toBe(true)
  expect(getModCapabilitySignal(captured!).reason).toBe(parent.signal.reason)
})

test('timeout and throw abort the failed operation; a successful catch keeps a separate signal',async()=>{
  for(const mode of ['timeout','throw'] as const){
    let failed:ModNext,recovered:ModNext
    const result=await dispatchModEvent({event:'tool.call',input:{},budgetMs:5,catchGraceMs:50,hooks:[{
      plugin:mode,tier:'user',registration:{id:1,event:'tool.call',hasCatch:true},
      invoke:async(e,next,catching)=>{
        if(catching){recovered=next;return next(e)}
        failed=next
        if(mode==='throw')throw Error('explicit failure')
        return new Promise(()=>{})
      },
    }],core:async()=>({result:'recovered'})})
    expect(result).toEqual({result:'recovered'})
    expect(getModCapabilitySignal(failed!).aborted).toBe(true)
    expect(failed!.signal.aborted).toBe(true)
    expect(recovered!.signal.aborted).toBe(true)
    expect(getModCapabilitySignal(recovered!).aborted).toBe(false)
  }
})
