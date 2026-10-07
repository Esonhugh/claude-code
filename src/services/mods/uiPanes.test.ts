import {afterEach,beforeEach,expect,test} from 'bun:test'
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createModsRuntime} from './runtime.js'
import {createModUi,type ModUiPresentation} from './ui.js'

const wide:ModUiPresentation={columns:160,rows:40,isFullscreen:true,composerEmpty:true,hasDialog:false,keyboardOwned:false}
const narrow={...wide,columns:100}
let root:string
const runtimes:ReturnType<typeof createModsRuntime>[]=[]
beforeEach(async()=>{root=await realpath(await mkdtemp(join(tmpdir(),'mods-ui-panes-')))})
afterEach(async()=>{await Promise.all(runtimes.splice(0).map(value=>value.dispose()));await rm(root,{recursive:true,force:true})})
function runtime(){const diagnostics:unknown[]=[];const value=createModsRuntime({services:{uiPresentation:()=>wide},onDiagnostic:e=>diagnostics.push(e)});runtimes.push(value);return {value,diagnostics}}
async function plugin(source:string,name='owner'){
 const entry=join(root,name+'.ts');await writeFile(entry,source)
 return {name,storageId:name+'@owned',pluginRoot:root,entrypoints:[entry]}
}
const binding=()=>({cwd:root,sessionId:'owned',surface:'terminal' as const,isInteractive:true})
const source=(generation:string)=>`export function register(on){
 on('session.start',async($,e,next)=>{const panes=await $.ui.panes();if(!panes.some(p=>p.id==='keep'))await $.ui.open({id:'keep',title:'Kept'});return next(e)});
 on('ui.render',{component:'Pane'},($,e)=>$.ui.resolve(e).Button({key:'run',label:'${generation}',onPress:()=>{}}));
 on('tool.call',async($)=>({result:await $.ui.panes()}));
}`

test('real Worker admits ui.panes and returns exactly the plugin pane projection',async()=>{
 const {value,diagnostics}=runtime();await value.bind(binding());await value.reconcile([await plugin(source('first'))])
 expect(diagnostics).toEqual([])
 expect(await value.dispatch('tool.call',{},async()=>({result:'unhandled'}))).toEqual({result:[{id:'keep',title:'Kept',isShown:true,isFocused:false,isPlaced:true}]})
})

test('ui.panes middleware receives a frozen empty event, can deny and can replace its value',async()=>{
 const {value,diagnostics}=runtime();const policy=await plugin(`let mode=0;export function register(on){
  on('ui.panes',($,e,next)=>{if(Object.keys(e).length||!Object.isFrozen(e))throw Error('expected frozen no-args event');mode++;return mode===1?{deny:'held'}:{value:[{id:'provided',title:'Policy',isShown:false,isFocused:false,isPlaced:false}]}});
 }`,'policy')
 const caller=await plugin(`export function register(on){on('tool.call',async($)=>{let denied;try{await $.ui.panes()}catch(e){denied=e.message}return {result:{denied,panes:await $.ui.panes()}}})}`)
 await value.bind(binding());await value.reconcile([policy,caller]);expect(diagnostics).toEqual([])
 expect(await value.dispatch('tool.call',{},async()=>({result:null}))).toEqual({result:{denied:'held',panes:[{id:'provided',title:'Policy',isShown:false,isFocused:false,isPlaced:false}]}})
})

test('reload discovers engine-owned panes and keeps their order while replacing drawing leases',async()=>{
 const {value,diagnostics}=runtime();const own=await plugin(source('first'))
 await value.bind(binding());await value.reconcile([own]);expect(diagnostics).toEqual([])
 const previous=value.ui.getSnapshot()[0]!
 await writeFile(own.entrypoints[0]!,source('second'));await value.reconcile([own])
 expect(diagnostics).toEqual([])
 const current=value.ui.getSnapshot()[0]!
 expect(current).toMatchObject({id:'keep',title:'Kept',tree:{props:{label:'second'}}})
 expect(current.drawing).not.toBe(previous.drawing)
 await expect(value.ui.interact('keep',previous.drawing!,(previous.tree as any).press,'press','run')).rejects.toThrow(/stale/)
 expect(await value.dispatch('tool.call',{},async()=>({result:null}))).toEqual({result:[{id:'keep',title:'Kept',isShown:true,isFocused:false,isPlaced:true}]})
 await value.reconcile([]);expect(value.ui.getSnapshot()).toEqual([])
})

function uiFixture(){
 const ui=createModUi({pluginOf:o=>(o as {plugin:string}).plugin,dispatch:async(_o,_e,i,core)=>core(i),draw:async()=>({type:'Text',children:['pane']}),invokeDrawing:async()=>{},releaseDrawing:async()=>{}})
 return ui
}
test('pane records are frozen, owner-scoped, ordered placed first and independent of rendering internals',async()=>{
 const ui=uiFixture(),owner={plugin:'one'},other={plugin:'two'}
 await ui.commit(owner);await ui.commit(other)
 await ui.open(owner,{id:'wait',title:'Waiting'},{kind:'plugin'},narrow)
 await ui.open(other,{id:'other'},{kind:'plugin'},wide)
 await ui.open(owner,{id:'shown',title:'Shown'},{kind:'person'},wide)
 const panes=ui.panes(owner)
 expect(panes).toEqual([{id:'shown',title:'Shown',isShown:true,isFocused:false,isPlaced:true},{id:'wait',title:'Waiting',isShown:false,isFocused:false,isPlaced:false}])
 expect(Object.isFrozen(panes)).toBe(true);expect(panes.every(Object.isFrozen)).toBe(true)
 await ui.close(owner,'shown',{kind:'plugin'});expect(ui.panes(owner)).toEqual([{id:'wait',title:'Waiting',isShown:false,isFocused:false,isPlaced:false}])
 await ui.release(owner);expect(ui.panes(owner)).toEqual([]);expect(ui.panes(other)).toHaveLength(1)
 await ui.dispose()
})

test('new activation sees staged opens and a staged close survives reload commit',async()=>{
 const ui=uiFixture(),old={plugin:'one'},next={plugin:'one'}
 await ui.open(old,{id:'keep'},{kind:'person'},wide);await ui.open(old,{id:'close'},{kind:'plugin'},wide);await ui.commit(old)
 expect(ui.panes(next).map(p=>p.id)).toEqual(['keep','close'])
 await ui.close(next,'close',{kind:'plugin'});await ui.open(next,{id:'new'},{kind:'plugin'},wide)
 expect(ui.panes(next).map(p=>p.id)).toEqual(['keep','new'])
 expect(ui.getSnapshot().map(p=>p.id)).toEqual(['keep','close'])
 await ui.commit(next,old);expect(ui.panes(next).map(p=>p.id)).toEqual(['keep','new'])
 await ui.dispose()
})

test('real Worker returns detached mutable pane results and ignores extra JavaScript sugar arguments', async () => {
  const { value, diagnostics } = runtime()
  await value.bind(binding())
  await value.reconcile([await plugin(`export function register(on) {
    on('ui.render', { component: 'Pane' }, ($, e) => $.ui.resolve(e).Text({}, 'Owned pane'));
    on('tool.call', async ($) => {
      const empty = await $.ui.panes({ forged: 'argument' });
      await $.ui.open({ id: 'owned', title: 'Owned' });
      const panes = await $.ui.panes({ id: 'someone-else' });
      const original = panes.map(pane => ({ ...pane }));
      const listFrozen = Object.isFrozen(panes), recordsFrozen = panes.every(Object.isFrozen);
      panes[0].title = 'caller-only';
      panes.push({ id: 'caller-only', title: 'Caller only', isShown: false, isFocused: false, isPlaced: false });
      return { result: { empty, emptyFrozen: Object.isFrozen(empty), panes: original,
        listFrozen, recordsFrozen, current: await $.ui.panes() } };
    });
  }`)])
  expect(diagnostics).toEqual([])
  expect(await value.dispatch('tool.call', {}, async () => ({ result: null }))).toEqual({
    result: {
      empty: [], emptyFrozen: false,
      panes: [{ id: 'owned', title: 'Owned', isShown: true, isFocused: false, isPlaced: true }],
      listFrozen: false, recordsFrozen: false,
      current: [{ id: 'owned', title: 'Owned', isShown: true, isFocused: false, isPlaced: true }],
    },
  })
})

test('reload preserves global open order across other plugins and appends only new panes', async () => {
  const ui = uiFixture()
  const old = { plugin: 'one' }, next = { plugin: 'one' }, other = { plugin: 'two' }
  await ui.commit(old)
  await ui.commit(other)
  await ui.open(old, { id: 'first' }, { kind: 'person' }, wide)
  await ui.open(other, { id: 'middle' }, { kind: 'person' }, wide)
  await ui.open(old, { id: 'last' }, { kind: 'person' }, wide)
  await ui.close(next, 'last', { kind: 'plugin' })
  await ui.open(next, { id: 'new' }, { kind: 'person' }, wide)
  await ui.commit(next, old)
  expect(ui.getSnapshot().map(pane => pane.id)).toEqual(['first', 'middle', 'new'])
  expect(ui.panes(next).map(pane => pane.id)).toEqual(['first', 'new'])
  expect(ui.panes(other).map(pane => pane.id)).toEqual(['middle'])
  await ui.dispose()
})


test('a pending person focus receipt cannot claim the replacement pane even within one activation', async () => {
  const owner = {plugin: 'one'}
  const pending = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  let draws = 0
  const ui = createModUi({
    pluginOf: value => (value as typeof owner).plugin,
    dispatch: async (_owner, _event, input, core) => core(input),
    draw: async (_owner, _input, drawing) => {
      if (++draws === 2) { entered.resolve(); await pending.promise }
      return {type: 'Button', props: {key: 'run', label: 'Run'}, press: {plugin: 'one', handle: drawing}}
    },
    invokeDrawing: async () => {}, releaseDrawing: async () => {},
  })
  await ui.open(owner, {id: 'keep', focus: true}, {kind: 'person'}, wide)
  await ui.commit(owner)
  const redraw = ui.render(wide)
  await entered.promise
  const focusing = ui.focus(owner, {requestId: 'keep', element: 'run', origin: {kind: 'person'}}, wide)
  try {
    await ui.open(owner, {id: 'keep'}, {kind: 'plugin'}, wide)
    await expect(focusing).resolves.toEqual({focused: false})
    expect(ui.panes(owner)).toEqual([{id: 'keep', title: 'keep', isShown: true, isFocused: true, isPlaced: true}])
  } finally {
    pending.resolve(); await redraw; await ui.dispose()
  }
})
