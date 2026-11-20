import {afterEach, beforeEach, expect, test} from 'bun:test'
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createModsRuntime} from './runtime.js'
import {createModRemoteRenderer} from './remoteUiRender.js'
import {withModPlacedRows} from './placedRows.js'
import {createUserMessage} from '../../utils/messages.js'

let root: string, runtime: ReturnType<typeof createModsRuntime>
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mods-theme329-')))
  runtime = createModsRuntime()
  await runtime.bind({cwd:root,sessionId:'test-theme',isInteractive:false,surface:null})
})

test('SDK theme negotiation and backdrop clicks belong to the setting plugin', async () => {
  const path = join(root,'register.mjs')
  await writeFile(path, `let seen; export function register(on){
    on('tool.call',async ($,e)=>({result:e.tool==='set'?await $.theme.set({backdrop:{scene:'pond'}}):seen}));
    on('ui.pointer',($,e,next)=>{seen=e;return next(e)});
  }`)
  await runtime.reconcile([{name:'look',storageId:'look@fixture',pluginRoot:root,entrypoints:[path]}])
  runtime.remoteClients.attach({clientId:'phone',surface:'mobile',draws:['Theme']})
  const call = (tool:string) => runtime.dispatch('tool.call',{tool},async()=>({result:'missed'}))
  expect(await call('set')).toEqual({result:{isDrawn:true,requestId:'backdrop'}})
  const renderer = createModRemoteRenderer(runtime)
  try {
    const draw = await renderer.render({subtype:'ui_render',component:'Theme',client_id:'phone',instance_id:'backdrop',surface:'mobile',props:{plugin:'forged'}})
    expect(draw.props).toMatchObject({plugin:'look',scene:'pond',glass:{blur:16,opacity:0.6},isPointerHeard:true})
    const address = {subtype:'ui_message' as const,component:'Theme' as const,surface:'mobile' as const,instance_id:'backdrop',module:'',client:'',data:{type:'click',x:0.4,y:0.6}}
    expect(await renderer.clientMessage({...address,plugin:'other'})).toEqual({handled:false})
    expect(await renderer.clientMessage({...address,plugin:'look'})).toEqual({handled:true})
    expect(await call('get')).toMatchObject({result:{component:'Backdrop',surface:'mobile',scene:'pond',x:26/64,y:38/64}})
    runtime.remoteClients.attach({clientId:'phone',surface:'mobile',draws:[]})
    expect(await call('set')).toMatchObject({result:{isDrawn:false}})
  } finally {await renderer.dispose()}
})

test('author operations place a display-only row once and paint without reading the draft', async () => {
  await runtime.dispose()
  const messages = [createUserMessage({content:'hello'})]
  const layers = new Map<string, unknown>()
  runtime = createModsRuntime({services:{rawMessages:()=>messages, prompt:() => ({read:()=>({text:'secret draft',cursor:4}),fill:()=>false,
    paint:(layer,input)=>{layers.set(layer,input);return true}})}})
  await runtime.bind({cwd:root,sessionId:'test-placed',surface:'terminal',isInteractive:true})
  const path = join(root,'register.mjs')
  await writeFile(path, `export function register(on){on('tool.call',async ($,e)=>({result:e.tool==='place'?await $.ui.place({id:'demo'}):await $.prompt.paint({text:'secret draft', decorations:[{start:0,end:2,bold:true}]})}))}`)
  await runtime.reconcile([{name:'row',storageId:'row@fixture',pluginRoot:root,entrypoints:[path]}])
  const call = (tool:string) => runtime.dispatch('tool.call',{tool},async()=>({result:'missed'}))
  const first = await call('place')
  expect(first).toMatchObject({result:{isPlaced:true,requestId:expect.any(String)}})
  expect(await call('place')).toEqual(first)
  const projected = withModPlacedRows(messages, runtime.placed.rows())
  expect(projected[1]).toMatchObject({type:'system',subtype:'placed',id:'demo',plugin:'row'})
  expect(messages).toHaveLength(1)
  expect(await call('paint')).toEqual({result:{isPainted:true,text:'',cursor:0}})
  await runtime.reconcile([])
  expect([...layers.values()]).toEqual([{decorations:[]}])
})

test.each([true,false])('paint receipt respects each recipient when caller read is %s', async callerReads => {
  await runtime.dispose()
  const draft = {text:'new draft',cursor:5}, empty = {text:'',cursor:0}
  runtime = createModsRuntime({services:{prompt:()=>({read:()=>draft,fill:()=>false,paint:()=>false})}})
  await runtime.bind({cwd:root,sessionId:'paint',isInteractive:true,surface:'terminal'})
  const plugins = await Promise.all([['caller',`on('tool.call',{tool:'paint'},async $=>{${callerReads?'await $.prompt.read();':''}return {result:await $.prompt.paint({text:'old draft',decorations:[]})}})`],
    ['observer',`on('prompt.paint',async ($,e,next)=>{${callerReads?'':'await $.prompt.read();'}const receipt=await next(e);seen=receipt.value;return receipt});on('tool.call',{tool:'observe'},()=>({result:seen}))`]].map(async ([name,body])=>{
    const path=join(root,name+'.mjs');await writeFile(path,`let seen;export function register(on){${body}}`)
    return {name:name!,storageId:name+'@fixture',pluginRoot:root,entrypoints:[path]}
  }))
  await runtime.reconcile(plugins)
  const call=(tool:string)=>runtime.dispatch('tool.call',{tool},async()=>({result:'missing'}))
  expect(await call('paint')).toEqual({result:{isPainted:false,...(callerReads?draft:empty)}})
  expect(await call('observe')).toEqual({result:{isPainted:false,...(callerReads?empty:draft)}})
})

test('author static grounds and desktop-only style/sound payloads survive a late client join', async () => {
  const path = join(root,'register.mjs')
  await writeFile(path, `export function register(on){on('tool.call',async ($,e)=>{try{return {result:await $.theme.set(e.input)}}catch(error){return {result:{error:error.message}}}})}`)
  await runtime.reconcile([{name:'look',storageId:'look@fixture',pluginRoot:root,entrypoints:[path]}])
  const call = (input:unknown) => runtime.dispatch('tool.call',{tool:'set',input},async()=>({result:'missed'}))
  const backdrop = {gradient:{stops:['#112233','surface-2'],angle:45}}, style = {Text:{fontFamily:['serif'],fontSize:18}}, sound = {cues:{done:{layers:[{wave:'bell',notes:['E5','G5'],step:0.1}]}}}
  expect(await call({backdrop,style,sound})).toMatchObject({result:{isDrawn:false,requestId:'theme'}})
  const renderer = createModRemoteRenderer(runtime)
  const draw = async (surface:'desktop'|'mobile',instance_id:string) => (await renderer.render({subtype:'ui_render',surface,instance_id,component:'Theme',props:{}})).props
  try {
    const payload = await draw('desktop','theme')
    expect(payload.backdrop).toEqual(backdrop)
    expect(payload.plugin).toBe('look')
    expect(payload.styleHash).toBeString()
    expect(payload.soundHash).toBeString()
    expect(await draw('desktop',`style:${payload.styleHash}`)).toEqual({style})
    expect(await draw('desktop',`sound:${payload.soundHash}`)).toEqual({sound})
    expect(await draw('mobile','theme')).toEqual({backdrop,plugin:'look'})
    expect(await draw('mobile',`sound:${payload.soundHash}`)).toEqual({})
    expect(await call({style:{Text:{fontSize:1000}}})).toMatchObject({result:{error:expect.stringContaining('fontSize')}})
    expect(await call({sound:{cues:{done:{layers:[{wave:'bell',notes:[99999]}]}}}})).toMatchObject({result:{error:expect.stringContaining('sound')}})
    expect(await draw('desktop','theme')).toEqual(payload)
    await call({backdrop:{color:'#223344'}})
    expect(await draw('mobile','theme')).toEqual({plugin:'look',backdrop:{color:'#223344'}})
  } finally {await renderer.dispose()}
})
afterEach(async () => { await runtime.dispose(); await rm(root,{recursive:true,force:true}) })

test('a session theme stands without a surface, can be replaced and is cleared on unload', async () => {
  const path = join(root, 'register.mjs')
  await writeFile(path, `export function register(on){on('tool.call',async ($,e)=>({result:e.tool==='clear'?await $.theme.clear():await $.theme.set(e.input)}))}`)
  await runtime.reconcile([{name:'look',storageId:'look@fixture',pluginRoot:root,entrypoints:[path]}])
  const call = (input:unknown,tool='set') => runtime.dispatch('tool.call',{tool,input},async()=>({result:'missed'}))
  expect(await call({overrideColorScheme:'dark'})).toMatchObject({result:{isDrawn:false,requestId:'theme'}})
  expect(runtime.theme.props('theme')).toEqual({plugin:'look',overrideColorScheme:'dark'})
  expect(await call({backdrop:{scene:'pond'}})).toEqual({result:{isDrawn:false,requestId:'backdrop',reason:'no attached desktop or mobile client draws themes yet; the theme stands and draws when one attaches'}})
  expect(runtime.theme.props('backdrop')).toMatchObject({plugin:'look',scene:'pond'})
  expect(runtime.theme.props('theme')).toEqual({})
  expect(await call({},'clear')).toEqual({result:{isDrawn:false,reason:'the theme is cleared'}})
  expect(runtime.theme.props('backdrop')).toEqual({})
  await call({overrideColorScheme:'light'})
  await runtime.reconcile([])
  expect(runtime.theme.props('theme')).toEqual({})
})
