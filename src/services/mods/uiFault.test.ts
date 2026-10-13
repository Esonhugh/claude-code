import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime } from './runtime.js'

let root: string
const runtimes: ReturnType<typeof createModsRuntime>[] = []
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'mods-fault-')) })
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
  await rm(root, { recursive: true, force: true })
})

const cases = [
  ['load', `throw new TypeError(''); export default function Broken() {}`, 'TypeError'],
  ['render', `export default function Broken() {throw Error('owner: Client broken.ts: first\\nsecond\\u2028third')}`, 'first second third'],
  ['render', `export default function Broken() {throw Error('x'.repeat(210))}`, 'x'.repeat(199) + '…'],
  ['render', `export default function Broken() {throw Error('x'.repeat(198)+'😀'+'y'.repeat(10))}`, 'x'.repeat(198) + '…'],
  ['render', `export default function Broken() {throw Error('a\\ud800\\u{10eeee}\\tb')}`, 'a   b'],
  ['render', `export default function Broken() {throw Error('')}`, 'the module failed without a message'],
  ['run', `export default function Broken(_, s) { if(s.state===undefined) {s.setState(0);s.every(1,()=>{throw Error('timer failed')})} return s.elements.Text({children:'ready'}) }`, 'timer failed'],
] as const

test.each(cases)('real Client Worker emits an own-plugin %s fault with pinned fields', async (phase, clientSource, reason) => {
  const pluginRoot = join(root, 'owner')
  await mkdir(pluginRoot)
  const entry = join(pluginRoot, 'register.ts')
  await writeFile(entry, `export function register(on) {
    on('session.start', async ($,e,next)=>{await $.ui.open({id:'panel'});return next(e)});
    on('ui.render', ($,e)=>$.ui.resolve(e).Client({key:'broken',module:'./broken.ts'}));
    on('ui.fault', async ($,e,next)=>{
      const failures=[];
      for(const key of ['surface','component','requestId','element','module','phase','reason']) {
        try {await next({...e,[key]:'forged'})} catch(error) {failures.push(key)}
      }
      const result=await next(e);await $.ui.status(JSON.stringify({e,failures,result}));return result;
    });
  }`)
  await writeFile(join(pluginRoot, 'broken.ts'), clientSource)
  const observerRoot = join(root, 'observer')
  await mkdir(observerRoot)
  const observer = join(observerRoot, 'register.ts')
  await writeFile(observer, `export function register(on) {on('ui.fault', ($)=>{$.ui.status('cross-plugin leak');return {}})}`)
  const heard = Promise.withResolvers<any>()
  const statuses: unknown[] = []
  const runtime = createModsRuntime({ services: {
    uiPresentation: () => ({ columns: 160, rows: 40, isFullscreen: true, composerEmpty: true, hasDialog: false, keyboardOwned: false }),
    uiStatus: (name, text) => {if(text!==undefined) {statuses.push(name); if(name==='owner') heard.resolve(JSON.parse(text))}},
  } })
  runtimes.push(runtime)
  await runtime.bind({cwd:root,surface:'terminal',isInteractive:true,sessionId:'fault'})
  await runtime.reconcile([
    {name:'observer',storageId:'observer@test',pluginRoot:observerRoot,entrypoints:[observer]},
    {name:'owner',storageId:'owner@test',pluginRoot,entrypoints:[entry]},
  ])
  const pane = runtime.ui.getSnapshot()[0]!
  expect(pane).toBeDefined()
  expect(pane.visible).toBe(true)
  expect(pane.tree).toMatchObject({type:'Client',group:{plugin:'owner'}})
  const handle = pane.clients!.mount({...pane,clock:'manual'}, pane.tree, () => {})
  try {
    if(phase==='run') {
      await handle.ready
      const error = await handle.advance(1).then(()=>null,error=>error)
      expect(error).toMatchObject({message:reason,phase:'run'})
    }
    else await expect(handle.ready).rejects.toThrow()
    const result = await heard.promise
    expect(result).toEqual({e:{surface:'terminal',component:'Pane',requestId:'panel',element:'broken',module:'broken.ts',phase,reason},failures:['surface','component','requestId','element','module','phase','reason'],result:{}})
    expect(statuses).toEqual(['owner'])
  } finally {await handle.dispose()}
})

test('a heard real Worker fault redraws its live Pane once and a fault in that generation is still heard without a loop', async () => {
  const pluginRoot=join(root,'owner')
  await mkdir(pluginRoot)
  const entry=join(pluginRoot,'register.ts')
  await writeFile(entry,`let draws=0;export function register(on) {
    on('session.start',async($,e,next)=>{await $.ui.open({id:'panel'});return next(e)});
    on('ui.render',($,e)=>{draws++;return $.ui.resolve(e).Client({key:'broken',module:'./broken.ts'})});
    on('ui.fault',{phase:'render'},async($,e,next)=>{await $.ui.status('heard');return next(e)});
    on('tool.call',{tool:'Probe'},()=>({result:{draws}}));
  }`)
  await writeFile(join(pluginRoot,'broken.ts'),`export default function Broken() {throw Error('draw failed')}`)
  let faults=0
  const secondHeard=Promise.withResolvers<void>()
  const runtime=createModsRuntime({services:{
    uiPresentation:()=>({columns:160,rows:40,isFullscreen:true,composerEmpty:true,hasDialog:false,keyboardOwned:false}),
    uiStatus:(_name,text)=>{if(text==='heard' && ++faults===2) secondHeard.resolve()},
  }})
  runtimes.push(runtime)
  await runtime.bind({cwd:root,surface:'terminal',isInteractive:true,sessionId:'fault-redraw'})
  await runtime.reconcile([{name:'owner',storageId:'owner@test',pluginRoot,entrypoints:[entry]}])
  const first=runtime.ui.getSnapshot()[0]!
  const redrawn=Promise.withResolvers<void>()
  const unsubscribe=runtime.ui.subscribe(()=>{
    if(runtime.ui.getSnapshot()[0]?.drawing!==first.drawing) redrawn.resolve()
  })
  const failed=first.clients!.mount(first,first.tree,()=>{})
  try {
    await failed.ready.catch(()=>{})
    await redrawn.promise
    const current=runtime.ui.getSnapshot()[0]!
    const again=current.clients!.mount(current,current.tree,()=>{})
    try {
      await again.ready.catch(()=>{})
      await secondHeard.promise
      await runtime.ui.redrawForFault(current)
      const probe=await runtime.dispatch('tool.call',{tool:'Probe'},async()=>({result:null}))
      expect(probe).toEqual({result:{draws:2}})
      expect(faults).toBe(2)
      expect(current.drawing).not.toBe(first.drawing)
    } finally {await again.dispose()}
  } finally {unsubscribe();await failed.dispose()}
})
