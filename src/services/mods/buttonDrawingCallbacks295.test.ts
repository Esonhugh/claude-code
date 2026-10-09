import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime } from './runtime.js'
import type { ModEnvironment } from './environment.js'

const presentation = { columns: 160, rows: 40, isFullscreen: true,
  composerEmpty: true, hasDialog: false, keyboardOwned: false }

for (const retained of [true, false]) {
  test(`real Worker core entry checks the guest after its selected drawing releases (${retained ? 'another holder' : 'no holder'})`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'mods-core-guest-295-'))
    const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
    let armed = false, pending: Promise<unknown> | undefined
    const runtime = createModsRuntime({ services: { uiPresentation: () => presentation,
      uiLog: (_plugin, text) => { if (text === 'enter core') armed = true } } })
    try {
      const entry = join(root, 'register.ts')
      await writeFile(entry, `let cached,hidden=false,count=0;export function register(on){
        on('session.start',async($,e,next)=>{await $.ui.open({id:'first'});await $.ui.open({id:'second'});return next(e)});
        on('ui.render',{component:'Pane'},($,e)=>{const {Button,Text}=$.ui.resolve(e);
          cached??=Button({key:'save',label:'Save',onPress:()=>{count++}});
          return hidden && (${retained} ? e.requestId==='first' : true) ? Text({children:'removed'}) : cached});
        on('ui.press',async($,e,next)=>{await $.ui.log('enter core');return next(e)});
        on('command.run',{command:'hide'},()=>{hidden=true;return {}});
        on('tool.call',{tool:'ReadCount'},()=>({result:{count}}));
      }`)
      await runtime.bind({cwd:root,surface:'terminal',isInteractive:true,sessionId:'core-guest'})
      await runtime.reconcile([{name:'core-owner',storageId:'core-owner@test',pluginRoot:root,entrypoints:[entry]}])
      const before = runtime.ui.getSnapshot().find(pane => pane.id === 'first')!
      const callback = (before.tree as any).press
      const environment = (before.owner as {environment:ModEnvironment}).environment
      const setUiAccess = environment.setUiAccess.bind(environment)
      environment.setUiAccess = async allowed => {
        await setUiAccess(allowed)
        if (armed) { armed = false; entered.resolve(); await resume.promise }
      }
      pending = runtime.ui.interact(before.id,before.drawing!,callback,'press','save').then(value=>({value}),error=>({error}))
      await entered.promise
      await runtime.dispatch('command.run',{command:'hide',args:'',origin:{kind:'composer'}},async()=>({}))
      await runtime.ui.render({...presentation,rows:41})
      expect(runtime.ui.getSnapshot().every(pane=>pane.drawing!==before.drawing)).toBe(true)
      const count = await runtime.dispatch('tool.call',{tool:'ReadCount'},async()=>({result:null})) as any
      expect(count.result).toEqual({count:0})
      resume.resolve()
      const result = await pending as {value?:unknown,error?:Error}
      if (retained) expect(result).toEqual({value:{element:'save'}})
      else expect(result.error?.message).toMatch(/Unknown|stale|no handler/)
      const after = await runtime.dispatch('tool.call',{tool:'ReadCount'},async()=>({result:null})) as any
      expect(after.result).toEqual({count:retained ? 1 : 0})
    } finally {
      resume.resolve(); await pending; await runtime.dispose(); await rm(root,{recursive:true,force:true})
    }
  })
}

for (const stable of [true, false]) {
  test(`real Worker ${stable ? 'held' : 'released'} callback settles across a redraw during ui.press middleware`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'mods-held-callback-295-'))
    const entered = Promise.withResolvers<void>()
    const diagnostics: unknown[] = []
    const runtime = createModsRuntime({onDiagnostic: value => diagnostics.push(value),
      services: {uiPresentation: () => presentation, uiLog: (_plugin, text) => {
        if (text === 'press parked') entered.resolve()
      }}})
    let pending: Promise<unknown> | undefined
    try {
      const entry = join(root, 'register.ts')
      await writeFile(entry, `let resume, cached, first = true, count = 0;
        const held = e => { count++ };
        export function register(on) {
          on('session.start', async ($, e, next) => {await $.ui.open({id:'held'});return next(e)});
          on('ui.render', {component:'Pane'}, ($, e) => ${stable ? '(cached ??= ' : ''}$.ui.resolve(e).Button({
            key:'save',label:'Save',onPress:${stable ? 'held' : 'e => {count++}'}})${stable ? ')' : ''});
          on('ui.press', async ($, e, next) => {
            if(first){first=false;await $.ui.log('press parked');await new Promise(resolve => {resume=resolve})}return next(e)
          });
          on('command.run', {command:'resume'}, () => {resume();return {}});
          on('tool.call', {tool:'ReadCount'}, () => ({result:{count}}));
        }`)
      await runtime.bind({cwd:root,surface:'terminal',isInteractive:true,sessionId:'held-callback'})
      await runtime.reconcile([{name:'held-owner',storageId:'held-owner@test',pluginRoot:root,entrypoints:[entry]}])
      expect(diagnostics).toEqual([])
      const before = runtime.ui.getSnapshot()[0]!
      const callback = (before.tree as any).press
      const started = runtime.ui.interact(before.id,before.drawing!,callback,'press','save')
      pending = started.then(value => ({value}), error => ({error}))
      await entered.promise
      await runtime.ui.render({...presentation,rows:41})
      const after = runtime.ui.getSnapshot()[0]!
      expect(after.drawing).not.toBe(before.drawing)
      if (stable) expect((after.tree as any).press).toEqual(callback)
      else expect((after.tree as any).press.handle).not.toBe(callback.handle)
      await runtime.dispatch('command.run',{command:'resume',args:'',origin:{kind:'composer'}},async()=>({}))
      const result = await pending as {value?:unknown,error?:Error}
      if (stable) expect(result).toEqual({value:{element:'save'}})
      else expect(result.error?.message).toMatch(/stale|no handler|Unknown drawing callback/i)
      const count = await runtime.dispatch('tool.call',{tool:'ReadCount'},async()=>({result:null})) as any
      expect(count.result).toEqual({count:stable ? 1 : 0})
      await expect(runtime.ui.interact(before.id,before.drawing!,callback,'press','save')).rejects.toThrow(/stale/)
      await runtime.ui.interact(after.id,after.drawing!,(after.tree as any).press,'press','save')
      const current = await runtime.dispatch('tool.call',{tool:'ReadCount'},async()=>({result:null})) as any
      expect(current.result).toEqual({count:stable ? 2 : 1})
    } finally {
      await runtime.dispose()
      await pending
      await rm(root,{recursive:true,force:true})
    }
  })
}

for (const phase of ['callback', 'close'] as const) {
  test(`real Worker ${phase === 'callback' ? 'already-started callback survives its release' : 'closed Pane rejects a pending callback'}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'mods-callback-phase-295-'))
    const entered = Promise.withResolvers<void>()
    const runtime = createModsRuntime({services:{uiPresentation:()=>presentation,
      uiLog:(_plugin,text)=>{if(text==='parked')entered.resolve()}}})
    let pending: Promise<unknown> | undefined
    try {
      const entry=join(root,'register.ts')
      const park="await $.ui.log('parked');await new Promise(resolve=>{resume=resolve});"
      await writeFile(entry, `let resume, count=0;export function register(on){
        on('session.start',async($,e,next)=>{await $.ui.open({id:'phase'});return next(e)});
        on('ui.render',{component:'Pane'},($,e)=>$.ui.resolve(e).Button({key:'save',label:'Save',
          onPress:async press=>{${phase==='callback' ? park : ''}count++}}));
        on('ui.press',async($,e,next)=>{${phase==='close' ? park : ''}return next(e)});
        on('command.run',{command:'resume'},()=>{resume();return {}});
        on('tool.call',{tool:'ReadCount'},()=>({result:{count}}));
      }`)
      await runtime.bind({cwd:root,surface:'terminal',isInteractive:true,sessionId:'callback-phase'})
      await runtime.reconcile([{name:'phase-owner',storageId:'phase-owner@test',pluginRoot:root,entrypoints:[entry]}])
      const before=runtime.ui.getSnapshot()[0]!
      const start=runtime.ui.interact(before.id,before.drawing!,(before.tree as any).press,'press','save')
      pending=start.then(value=>({value}),error=>({error}))
      await entered.promise
      if(phase==='callback') {
        await runtime.ui.render({...presentation,rows:41})
        expect(runtime.ui.getSnapshot()[0]!.drawing).not.toBe(before.drawing)
      } else {
        await runtime.ui.close(before.owner,before.id,{kind:'person'})
        expect(runtime.ui.getSnapshot()).toEqual([])
      }
      await runtime.dispatch('command.run',{command:'resume',args:'',origin:{kind:'composer'}},async()=>({}))
      const result=await pending as {value?:unknown,error?:Error}
      if(phase==='callback')expect(result).toEqual({value:{element:'save'}})
      else expect(result.error?.message).toMatch(/stale/)
      const count=await runtime.dispatch('tool.call',{tool:'ReadCount'},async()=>({result:null})) as any
      expect(count.result).toEqual({count:phase==='callback' ? 1 : 0})
    } finally {
      await runtime.dispose();await pending;await rm(root,{recursive:true,force:true})
    }
  })
}

for (const keepElsewhere of [true, false]) {
  test(`real Worker accepted callback ${keepElsewhere ? 'remains held by another Pane' : 'retains its guest identity through a rewritten key'}`, async () => {
    const root=await mkdtemp(join(tmpdir(),'mods-guest-holders-295-'))
    const entered=Promise.withResolvers<void>()
    const runtime=createModsRuntime({services:{uiPresentation:()=>presentation,
      uiLog:(_plugin,text)=>{if(text==='parked')entered.resolve()}}})
    let pending:Promise<unknown>|undefined
    try {
      const entry=join(root,'register.ts')
      await writeFile(entry,`let cached,resume,first=true,changed=false,count=0;
        export function register(on){
          on('session.start',async($,e,next)=>{await $.ui.open({id:'first'});${keepElsewhere ? "await $.ui.open({id:'second'});" : ''}return next(e)});
          on('ui.render',{component:'Pane'},($,e)=>{
            cached??=$.ui.resolve(e).Button({key:'save',label:'Save',onPress:()=>{count++}});
            if(changed&&e.requestId==='first'&&${keepElsewhere})return $.ui.resolve(e).Text({children:'removed original node'});
            return cached;
          });
          on('ui.press',async($,e,next)=>{if(first){first=false;await $.ui.log('parked');await new Promise(resolve=>{resume=resolve})}return next(e)});
          on('command.run',{command:'change'},()=>{changed=true;return {}});
          on('command.run',{command:'resume'},()=>{resume();return {}});
          on('tool.call',{tool:'ReadCount'},()=>({result:{count}}));
        }`)
      await runtime.bind({cwd:root,surface:'terminal',isInteractive:true,sessionId:'guest-holders'})
      const decorator=join(root,'decorator.ts')
      if(!keepElsewhere)await writeFile(decorator,`let changed=false;export function register(on){
        on('command.run',{command:'change'},async($,e,next)=>{changed=true;return next(e)});
        on('ui.render',{component:'Pane'},async($,e,next)=>{const tree=await next(e);
          return changed&&e.requestId==='first' ? {...tree,props:{...tree.props,key:'renamed'}} : tree});
      }`)
      await runtime.reconcile([...(keepElsewhere ? [] : [{name:'key-decorator',storageId:'key-decorator@test',pluginRoot:root,entrypoints:[decorator]}]),
        {name:'holders',storageId:'holders@test',pluginRoot:root,entrypoints:[entry]}])
      const before=runtime.ui.getSnapshot().find(pane=>pane.id==='first')!
      const callback=(before.tree as any).press
      pending=runtime.ui.interact(before.id,before.drawing!,callback,'press','save').then(value=>({value}),error=>({error}))
      await entered.promise
      await runtime.dispatch('command.run',{command:'change',args:'',origin:{kind:'composer'}},async()=>({}))
      await runtime.ui.render({...presentation,rows:41})
      const holder=runtime.ui.getSnapshot().find(pane=>pane.id===(keepElsewhere ? 'second' : 'first'))!
      expect((holder.tree as any).press).toEqual(callback)
      expect(holder.drawing).not.toBe(before.drawing)
      await runtime.dispatch('command.run',{command:'resume',args:'',origin:{kind:'composer'}},async()=>({}))
      expect(await pending).toEqual({value:{element:'save'}})
      const count=await runtime.dispatch('tool.call',{tool:'ReadCount'},async()=>({result:null})) as any
      expect(count.result).toEqual({count:1})
    }finally{await runtime.dispose();await pending;await rm(root,{recursive:true,force:true})}
  })
}

test('real Worker cached guest keeps its identity after release and reappearance before core lookup', async()=>{
  const root=await mkdtemp(join(tmpdir(),'mods-guest-reappearance-295-'))
  const entered=Promise.withResolvers<void>()
  const runtime=createModsRuntime({services:{uiPresentation:()=>presentation,
    uiLog:(_plugin,text)=>{if(text==='parked')entered.resolve()}}})
  let pending:Promise<unknown>|undefined
  try{
    const entry=join(root,'register.ts')
    await writeFile(entry,`let cached,resume,hidden=false,count=0;export function register(on){
      on('session.start',async($,e,next)=>{await $.ui.open({id:'revive'});return next(e)});
      on('ui.render',{component:'Pane'},($,e)=>{const {Button,Text}=$.ui.resolve(e);
        cached??=Button({key:'save',label:'Save',onPress:()=>{count++}});return hidden ? Text({children:'no guest held'}) : cached});
      on('ui.press',async($,e,next)=>{await $.ui.log('parked');await new Promise(resolve=>{resume=resolve});return next(e)});
      on('command.run',{command:'hide'},()=>{hidden=true;return {}});
      on('command.run',{command:'show'},()=>{hidden=false;return {}});
      on('command.run',{command:'resume'},()=>{resume();return {}});
      on('tool.call',{tool:'ReadCount'},()=>({result:{count}}));
    }`)
    await runtime.bind({cwd:root,surface:'terminal',isInteractive:true,sessionId:'revive'})
    await runtime.reconcile([{name:'revive-owner',storageId:'revive-owner@test',pluginRoot:root,entrypoints:[entry]}])
    const before=runtime.ui.getSnapshot()[0]!,callback=(before.tree as any).press
    pending=runtime.ui.interact(before.id,before.drawing!,callback,'press','save').then(value=>({value}),error=>({error}))
    await entered.promise
    await runtime.dispatch('command.run',{command:'hide',args:'',origin:{kind:'composer'}},async()=>({}))
    await runtime.ui.render({...presentation,rows:41})
    expect(runtime.ui.getSnapshot()[0]!.tree).toMatchObject({type:'Text',children:['no guest held']})
    await expect(runtime.ui.interact(before.id,before.drawing!,callback,'press','save')).rejects.toThrow(/stale/)
    // The ordered Worker reply follows render's acknowledged release-drawing request.
    const removed=await runtime.dispatch('tool.call',{tool:'ReadCount'},async()=>({result:null})) as any
    expect(removed.result).toEqual({count:0})
    await runtime.dispatch('command.run',{command:'show',args:'',origin:{kind:'composer'}},async()=>({}))
    await runtime.ui.render({...presentation,rows:42})
    expect((runtime.ui.getSnapshot()[0]!.tree as any).press).toEqual(callback)
    await runtime.dispatch('command.run',{command:'resume',args:'',origin:{kind:'composer'}},async()=>({}))
    expect(await pending).toEqual({value:{element:'save'}})
    const count=await runtime.dispatch('tool.call',{tool:'ReadCount'},async()=>({result:null})) as any
    expect(count.result).toEqual({count:1})
  }finally{await runtime.dispose();await pending;await rm(root,{recursive:true,force:true})}
})
