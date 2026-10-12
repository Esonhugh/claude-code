import {expect,test} from 'bun:test'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createModsRuntime} from './runtime.js'
import type {ModTerminalClientHandle} from './terminalClient.js'

const delay = () => new Promise(resolve => setTimeout(resolve,10))
async function fixture(run: (host: {
 runtime: ReturnType<typeof createModsRuntime>; root: string; entry: string
 acquire(props?:unknown): ModTerminalClientHandle
 waitForMessage(): Promise<void>
 size: {columns:number;rows:number;conversationColumns:number}
}) => Promise<void>) {
 const root = await mkdtemp(join(tmpdir(),'mods-terminal-runtime-'))
 const entry = join(root,'register.ts')
 await writeFile(entry,`export function register(on) {
  on('session.start',async($,e,next)=>{await $.ui.open({id:'panel'});return next(e)});
  on('ui.render',($,e)=>{const {Client}=$.ui.resolve(e);return e.props.module==='b'?Client({key:'surface',module:'./b.ts',props:e.props.value}):Client({key:'surface',module:'./a.ts',props:e.props.value})});
  on('ui.message',async($,e)=>{if(e.data==='late'){await $.ui.status('message started');await $.clock.sleep(40);return {props:'obsolete reply'}}return {props:e.data}});
 }`)
 const source = (name:string) => `export default function Surface(props,s) {
  if(props==='vm-render')throw Error('ordinary VM render failed');
  if(s.state===undefined){s.setState(0);s.onKey(e=>{if(e.key==='throw')throw Error('ordinary VM run failed');s.setState(s.state+1)})}
  return s.elements.Text({children:'${name}:'+JSON.stringify(props)+':state='+s.state});
 }`
 await writeFile(join(root,'a.ts'),source('a'));await writeFile(join(root,'b.ts'),source('b'))
 const started=Promise.withResolvers<void>()
 const runtime = createModsRuntime({services:{uiStatus:(_name,text)=>{if(text==='message started')started.resolve()},uiPresentation:()=>({columns:160,rows:40,isFullscreen:true,composerEmpty:true,hasDialog:false,keyboardOwned:false})}})
 const handles:ModTerminalClientHandle[]=[]
 const size={columns:160,rows:40,conversationColumns:111}
 try {
  await runtime.bind({cwd:root,surface:'terminal',isInteractive:true,sessionId:'terminal-runtime'})
  await runtime.reconcile([{name:'owner',storageId:'owner@test',pluginRoot:root,entrypoints:[entry]}])
  const acquire=(props?:unknown)=>{
   const pane=runtime.ui.getSnapshot()[0]!
   const node=pane.tree as any
   const next={...node,props:{...node.props,props}}
   const handle=pane.clients!.acquire!({...pane,clock:'manual'},next,()=>{},()=>size)
   handles.push(handle);return handle
  }
  await run({runtime,root,entry,acquire,size,waitForMessage:()=>started.promise})
 } finally {for(const handle of handles)await handle.dispose();await runtime.dispose();await delay();await rm(root,{recursive:true,force:true})}
}
const drawn = (handle:ModTerminalClientHandle):string => {
 const snapshot=handle.getSnapshot();expect(snapshot.status).toBe('drawn')
 return JSON.stringify(snapshot.status==='drawn'?snapshot.tree:undefined)
}

test('actual Worker same-owner terminal holders retain state and revoke each released lease',async()=>fixture(async({acquire})=>{
 const first=acquire({a:1});await first.ready;await first.key({key:'increment'});await first.settled()
 expect(drawn(first)).toContain('state=1')
 const second=acquire({a:1});await second.ready
 expect(drawn(second)).toContain('state=1')
 await first.dispose();await expect(first.key({key:'stale'})).rejects.toThrow('stale');expect(()=>first.retain(()=>({columns:160,rows:40,conversationColumns:111}))).toThrow('stale')
 await second.key({key:'increment'});await second.settled();expect(drawn(second)).toContain('state=2')
}))

test('actual Worker holder0 immediate reacquire cancels destruction; later remount creates fresh state',async()=>fixture(async({acquire})=>{
 const first=acquire();await first.ready;await first.key({key:'increment'});await first.settled()
 const released=first.dispose();const immediate=acquire();await released;await immediate.ready
 expect(drawn(immediate)).toContain('state=1')
 await immediate.dispose();await delay()
 const remounted=acquire();await remounted.ready
 expect(drawn(remounted)).toContain('state=0')
}))

test('actual Worker ui.message props do not change the terminal handed-props retry fingerprint',async()=>fixture(async({acquire})=>{
 const handle=acquire({a:1,b:2});await handle.ready;await handle.post({a:9,b:9})
 expect(drawn(handle)).toContain('9')
 handle.threw(Error('terminal rejected message frame'))
 expect(handle.getSnapshot().status).toBe('failed')
 handle.drawnAgain();await handle.settled()
 expect(handle.getSnapshot().status).toBe('failed')
 const equal=acquire({b:2,a:1});equal.drawnAgain();await equal.settled()
 expect(equal.getSnapshot().status).toBe('failed')
}))

for(const phase of ['render','run']) test(`actual Worker ordinary VM ${phase} failure cannot acquire a terminal retry token`,async()=>fixture(async({acquire,runtime,size})=>{
 const handle=acquire(phase==='render'?'vm-render':'good');await handle.ready
 if(phase==='run')await handle.key({key:'throw'}).catch(()=>{})
 expect(handle.getSnapshot().status).toBe('failed')
 size.columns++
 const pane=runtime.ui.getSnapshot()[0]!
 await handle.update(pane,{...pane.tree as any,props:{...(pane.tree as any).props,props:'new'}})
 handle.drawnAgain();await handle.settled()
 expect(handle.getSnapshot().status).toBe('failed')
}))

test('actual Worker terminal retry has fresh state and invalidates old callbacks while hook remains alive',async()=>fixture(async({acquire,runtime,size})=>{
 const handle=acquire();await handle.ready;await handle.key({key:'increment'});await handle.settled()
 expect(drawn(handle)).toContain('state=1')
 handle.threw(Error('terminal leaf failed'));size.rows++
 handle.drawnAgain();await handle.ready
 expect(drawn(handle)).toContain('state=0')
 expect(await runtime.dispatch('tool.call',{tool:'None'},async()=>({result:'alive'}))).toEqual({result:'alive'})
}))

test('actual retained render-site module change revokes its old numeric seat and uses the new module',async()=>fixture(async({runtime,size})=>{
 let handle:ModTerminalClientHandle|undefined
 const input={surface:'terminal' as const,component:'AbovePrompt' as const,requestId:'site',props:{module:'a',value:{a:1}},viewport:{columns:100,rows:20}}
 const site=await runtime.ui.mount(input,{surface:'terminal',retainClients:true,clientClock:'manual',terminalSize:()=>size,render(_tree,_drawing,_engine,bindings){handle=[...bindings!.values()][0]!.handle as ModTerminalClientHandle},unmount(){}})
 try {
  const original=handle!;expect(drawn(original)).toContain('a:')
  await original.key({key:'increment'});original.threw(Error('terminal failed'))
  await site.update({...input,props:{module:'b',value:{a:1}}})
  expect(handle).not.toBe(original);expect(drawn(handle!)).toContain('b:');expect(drawn(handle!)).toContain('state=0')
  await expect(original.key({key:'stale'})).rejects.toThrow('stale')
 } finally {await site.dispose()}
}))

test('actual runtime reload restores a failed Pane through a fresh activation and old lease stays retired',async()=>fixture(async({runtime,root,entry,acquire})=>{
 const old=acquire();await old.ready;old.threw(Error('terminal failure'))
 await writeFile(join(root,'a.ts'),`export default function Surface(_,s){return s.elements.Text({children:'reloaded module'})}`)
 await runtime.reconcile([{name:'owner',storageId:'owner@test',pluginRoot:root,entrypoints:[entry]}])
 const next=acquire();await next.ready;expect(drawn(next)).toContain('reloaded module')
 await expect(old.key({key:'stale'})).rejects.toThrow('stale');old.threw(Error('stale terminal error'));old.drawnAgain();expect(drawn(next)).toContain('reloaded module')
}))

test('actual retained terminal render-site reload restarts its logical host only after the new drawing',async()=>fixture(async({runtime,root,entry,size})=>{
 let handle:ModTerminalClientHandle|undefined
 const input={surface:'terminal' as const,component:'AbovePrompt' as const,requestId:'reload-site',props:{module:'a'},viewport:{columns:100,rows:20}}
 const site=await runtime.ui.mount(input,{surface:'terminal',retainClients:true,clientClock:'manual',terminalSize:()=>size,render(_tree,_drawing,_engine,bindings){handle=[...bindings!.values()][0]?.handle as ModTerminalClientHandle},unmount(){}})
 try {
  const original=handle!;original.threw(Error('terminal rejected'))
  await writeFile(join(root,'a.ts'),`export default function Surface(_,s){return s.elements.Text({children:'retained module reloaded'})}`)
  await runtime.reconcile([{name:'owner',storageId:'owner@test',pluginRoot:root,entrypoints:[entry]}])
  await site.update({...input,props:{module:'a',revision:2}});await handle!.ready
  expect(handle).toBe(original)
  expect(drawn(handle!)).toContain('retained module reloaded')
 } finally {await site.dispose()}
}))


test('actual pending ui.message reply from the retired numeric instance cannot overwrite a terminal retry',async()=>fixture(async({acquire,size,waitForMessage})=>{
 const handle=acquire('handed');await handle.ready
 const oldPost=handle.post('late');await waitForMessage()
 handle.threw(Error('terminal failure'));size.conversationColumns++
 handle.drawnAgain();await handle.ready;await oldPost
 await new Promise(resolve=>setTimeout(resolve,55))
 expect(drawn(handle)).toContain('handed');expect(drawn(handle)).not.toContain('obsolete reply')
 await handle.key({key:'increment'});await handle.settled();expect(drawn(handle)).toContain('state=1')
}))

test('actual terminal logical handle preserves owner/request/module identity admission',async()=>fixture(async({acquire,runtime})=>{
 const handle=acquire();await handle.ready
 const pane=runtime.ui.getSnapshot()[0]!;const node=pane.tree
 for(const changed of [{...pane,owner:{}},{...pane,id:'foreign'}])await expect(handle.update(changed,node)).rejects.toThrow('identity cannot change')
 await expect(handle.update(pane,{...node as any,props:{...(node as any).props,module:'b.ts'}})).rejects.toThrow('identity cannot change')
 expect(drawn(handle)).toContain('a:')
}))

for (const dimension of ['surface', 'component'] as const)
 for (const failed of [false, true])
  test(`actual Worker terminal ${failed ? 'failed' : 'drawn'} lease rejects changed ${dimension}`,async()=>fixture(async({acquire,runtime})=>{
   const handle=acquire();await handle.ready
   await handle.key({key:'increment'});await handle.settled()
   if(failed)handle.threw(Error('terminal boundary failed'))
   const pane=runtime.ui.getSnapshot()[0]!
   const changed=dimension==='surface'?{...pane,surface:'desktop' as const}:{...pane,component:'AbovePrompt' as const}
   await expect(handle.update(changed,pane.tree)).rejects.toThrow('identity cannot change')
   expect(handle.getSnapshot().status).toBe(failed?'failed':'drawn')
   if(!failed){await handle.key({key:'increment'});await handle.settled();expect(drawn(handle)).toContain('state=2')}
  }))

for (const dimension of ['surface', 'component'] as const)
 for (const failed of [false, true])
  test(`actual Worker reconcile retires ${failed ? 'failed' : 'drawn'} seat when only ${dimension} changes`,async()=>fixture(async({acquire,runtime})=>{
   const handle=acquire();await handle.ready
   if(failed)handle.threw(Error('terminal boundary failed'))
   const pane=runtime.ui.getSnapshot()[0]!
   const changed=dimension==='surface'?{...pane,surface:'desktop' as const}:{...pane,component:'AbovePrompt' as const}
   pane.clients!.reconcile([changed])
   await expect(handle.key({key:'must remain retired'})).rejects.toThrow('stale')
   expect(()=>handle.retain(()=>({columns:160,rows:40,conversationColumns:111}))).toThrow('stale')
   handle.threw(Error('retired boundary'));handle.drawnAgain()
   expect(await runtime.dispatch('tool.call',{tool:'None'},async()=>({result:'hook alive'}))).toEqual({result:'hook alive'})
  }))

test('actual Worker terminal identity normalizes undefined to terminal and Pane on update, acquire and reconcile',async()=>fixture(async({acquire,runtime,size})=>{
 const handle=acquire();await handle.ready
 await handle.key({key:'increment'});await handle.settled()
 const pane=runtime.ui.getSnapshot()[0]!
 const explicit={...pane,surface:'terminal' as const,component:'Pane' as const}
 const implicit={...pane,surface:undefined,component:undefined}
 await handle.update(explicit,pane.tree)
 await handle.update(implicit,pane.tree)
 pane.clients!.reconcile([explicit])
 const shared=pane.clients!.acquire!(implicit,pane.tree,()=>{},()=>size)
 try{
  await shared.ready;expect(drawn(shared)).toContain('state=1')
  pane.clients!.reconcile([implicit]);await shared.key({key:'increment'});await shared.settled()
  expect(drawn(handle)).toContain('state=2')
 }finally{await shared.dispose()}
}))
