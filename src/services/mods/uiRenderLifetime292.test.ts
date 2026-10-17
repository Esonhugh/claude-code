import { expect, test } from 'bun:test'
import { createModUi, type ModRenderInput, type ModRenderSite } from './ui.js'

const input: ModRenderInput = {surface:'terminal',component:'TurnDuration',requestId:'owned-row',props:{word:'Baked',durationMs:1},viewport:{columns:90,rows:24}}
function fixture() {
  const draws: {drawing:number;signal:AbortSignal;input:ModRenderInput;finish:(tree:unknown)=>void}[]=[]
  const released: number[]=[]
  const invoked: number[]=[]
  const ui=createModUi({
    pluginOf:()=> 'owned',dispatch:async(_owner,_event,e,next)=>next(e),
    draw:(_owner,e,drawing,_next,_validate,signal)=>new Promise((resolve,reject)=>{
      draws.push({drawing,signal:signal!,input:e as ModRenderInput,finish:resolve})
      signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true})
    }),
    releaseDrawing:async(_owner,drawing)=>{released.push(drawing)},
    invokeDrawing:async(_owner,drawing)=>{invoked.push(drawing)},
  })
  const button=(draw:number)=>({type:'Button',props:{key:'run',label:'Draw '+draw},press:{plugin:'owned',handle:draw}})
  return {ui,draws,released,invoked,button}
}
async function until(check:()=>boolean) {
  const deadline=Date.now()+1000
  while(!check()&&Date.now()<deadline)await new Promise<void>(resolve=>setImmediate(resolve))
  expect(check()).toBe(true)
}

test('native site binds before its first draw; unchanged input and invalid replacement do not cancel it', async()=>{
  const f=fixture();let site:ModRenderSite|undefined;const painted:unknown[]=[]
  const mounting=f.ui.mount(input,{surface:'terminal',onMount(value){site=value},render(tree){painted.push(tree)},unmount(){}})
  expect(site).toBeDefined()
  try{
    await until(()=>f.draws.length===1)
    const unchanged=site!.update({...input,viewport:{columns:90,rows:30}})
    await expect(site!.update({...input,requestId:'other-row'})).rejects.toThrow('identity cannot change')
    await expect(site!.update({...input,viewport:{columns:0,rows:24}})).rejects.toThrow('Invalid Mod UI render viewport')
    expect(f.draws[0]!.signal.aborted).toBe(false)
    expect(f.draws).toHaveLength(1)
    f.draws[0]!.finish(f.button(1));await mounting;await unchanged
    expect(painted).toHaveLength(1)
    expect(f.released).toEqual([])
  }finally{await site?.dispose()}
  expect(f.released).toEqual([1])
})

test('only the latest queued native input draws, and its cancelled lease is released', async()=>{
  const f=fixture();let site:ModRenderSite|undefined;const painted:unknown[]=[]
  const mounting=f.ui.mount(input,{surface:'terminal',onMount(value){site=value},render(tree){painted.push(tree)},unmount(){}})
  try{
    await until(()=>f.draws.length===1)
    const skipped=site!.update({...input,props:{...input.props,durationMs:2}})
    const newest=site!.update({...input,props:{...input.props,durationMs:3}})
    await until(()=>f.draws.length===2)
    expect(f.draws[0]!.signal.aborted).toBe(true)
    expect(f.draws[0]!.signal.reason.message).toBe('ui.render: superseded')
    expect(f.draws[1]!.input.props.durationMs).toBe(3)
    f.draws[0]!.finish(f.button(1));f.draws[1]!.finish(f.button(2))
    await Promise.all([mounting,skipped,newest])
    expect(painted).toEqual([f.button(2)])
    expect(f.released).toEqual([1])
  }finally{await site?.dispose()}
  expect(f.released).toEqual([1,2])
})

test('settled callbacks survive a pending redraw and expire only when the newest drawing commits', async()=>{
  const f=fixture();let site:ModRenderSite|undefined;let lease=0
  const mounting=f.ui.mount(input,{surface:'terminal',onMount(value){site=value},render(_tree,drawing){lease=drawing},unmount(){}})
  try{
    await until(()=>f.draws.length===1);f.draws[0]!.finish(f.button(1));await mounting
    const second=site!.update({...input,props:{...input.props,durationMs:2}})
    await until(()=>f.draws.length===2)
    await site!.interact(lease,{plugin:'owned',handle:1},'press','run')
    expect(f.invoked).toEqual([1]);expect(f.released).toEqual([])
    const third=site!.update({...input,props:{...input.props,durationMs:3}})
    await until(()=>f.draws.length===3);f.draws[2]!.finish(f.button(3))
    await Promise.all([second,third])
    await expect(site!.interact(1,{plugin:'owned',handle:1},'press','run')).rejects.toThrow('stale')
    await site!.interact(lease,{plugin:'owned',handle:3},'press','run')
    expect(f.invoked).toEqual([1,3]);expect(f.released).toEqual([2,1])
  }finally{await site?.dispose()}
  expect(f.released).toEqual([2,1,3])
})

test('consumer abort and explicit dispose clean a pending native mount exactly once', async()=>{
  const f=fixture();const lifetime=new AbortController();let site:ModRenderSite|undefined;let unmounted=0;let painted=0
  const mounting=f.ui.mount(input,{surface:'terminal',signal:lifetime.signal,onMount(value){site=value},render(){painted++},unmount(){unmounted++}})
  await until(()=>f.draws.length===1)
  lifetime.abort(new Error('owner unmounted'))
  await mounting;await site!.dispose();await f.ui.dispose()
  expect(f.draws[0]!.signal.aborted).toBe(true)
  expect(f.released).toEqual([1]);expect(unmounted).toBe(1);expect(painted).toBe(0)
  await expect(site!.update(input)).rejects.toThrow('stale')
})

test('an already aborted native consumer never starts or binds a drawing', async()=>{
  const f=fixture();const lifetime=new AbortController();let bound=0;let unmounted=0
  const reason=new Error('owner gone');lifetime.abort(reason)
  await expect(f.ui.mount(input,{surface:'terminal',signal:lifetime.signal,onMount(){bound++},render(){},unmount(){unmounted++}})).rejects.toBe(reason)
  expect(f.draws).toHaveLength(0);expect(f.released).toEqual([]);expect(bound).toBe(0);expect(unmounted).toBe(1)
  await f.ui.dispose();expect(unmounted).toBe(1)
})


test('repeated invalidation aborts an in-progress redraw instead of waiting behind it', async()=>{
  const f=fixture();const owner={};let site:ModRenderSite|undefined;const painted:unknown[]=[]
  const mounting=f.ui.mount(input,{surface:'terminal',onMount(value){site=value},render(tree){painted.push(tree)},unmount(){}})
  try{
    await until(()=>f.draws.length===1);f.draws[0]!.finish(f.button(1));await mounting
    await f.ui.commit(owner)
    const first=f.ui.invalidate(owner,'ui.render')
    await until(()=>f.draws.length===2)
    const second=f.ui.invalidate(owner,'ui.render')
    await until(()=>f.draws.length===3)
    expect(f.draws[1]!.signal.aborted).toBe(true)
    f.draws[2]!.finish(f.button(3));await Promise.all([first,second])
    expect(painted).toEqual([f.button(1),f.button(3)])
    expect(f.released).toEqual([2,1])
  }finally{await site?.dispose()}
})
