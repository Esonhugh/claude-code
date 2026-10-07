import { afterEach, beforeEach, expect, test } from 'bun:test'
import React from 'react'
import { PassThrough, Writable } from 'node:stream'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { render, Box, Text, useInput, type DOMElement } from '../../ink.js'
import { SystemTextMessage } from './SystemTextMessage.js'
import { createTurnDurationMessage } from '../../utils/messages.js'
import { createModsRuntime } from '../../services/mods/runtime.js'
import { ModsRenderContext } from '../../context/modsRenderContext.js'
import { AppStoreContext, getDefaultAppState } from '../../state/AppState.js'
import { createStore } from '../../state/store.js'
import ScrollBox, { type ScrollBoxHandle } from '../../ink/components/ScrollBox.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { getTurnCompletionVerb } from '../../constants/turnCompletionVerbs.js'
import { getModOnScreen } from '../../services/mods/renderGeometry.js'
import { subscribeFrame } from '../../ink/dom.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'

const envKeys = ['HOME','CLAUDE_CONFIG_DIR','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR','CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR','CLAUDE_CODE_NO_FLICKER']
let original: (string | undefined)[]
let root: string
let runtime: ReturnType<typeof createModsRuntime>
const seen: unknown[] = []
const diagnostics: unknown[] = []
let previousShow: boolean | undefined
beforeEach(async () => {
  original = envKeys.map(key => process.env[key])
  root = await realpath(await mkdtemp(join(tmpdir(), 'mods-duration-test-')))
  for (const key of envKeys.slice(0,5)) process.env[key] = root
  process.env.ANTHROPIC_API_KEY = 'owned-placeholder'
  for (const key of envKeys.slice(6)) delete process.env[key]
  process.env.CLAUDE_CODE_NO_FLICKER = '0'
  resetSettingsCache()
  previousShow = getGlobalConfig().showTurnDuration
  saveGlobalConfig(value => ({...value,showTurnDuration:true}))
  diagnostics.length = 0
  seen.length = 0
  runtime = createModsRuntime({ onDiagnostic(event) { diagnostics.push(event) }, services: { uiLog(_plugin,text) { seen.push(JSON.parse(text)) } } })
  await runtime.bind({ cwd:root,surface:'terminal',isInteractive:true,sessionId:'owned-duration' })
})
afterEach(async () => {
  try { await runtime.dispose(); await rm(root,{recursive:true,force:true}) }
  finally { saveGlobalConfig(value => ({...value,showTurnDuration:previousShow})); envKeys.forEach((key,i)=>{if(original[i]===undefined)delete process.env[key];else process.env[key]=original[i]});resetSettingsCache() }
})

async function load(body: string, component = 'TurnDuration', registrations = '') {
  const entry=join(root,'register.mjs')
  await writeFile(entry,`export function register(on){on('ui.render',{component:${JSON.stringify(component)}},async($,e,next)=>{ $.ui.log(JSON.stringify(e),{to:'debug'}); ${body} });${registrations}}`)
  await runtime.reconcile([{name:'owned-duration',storageId:'owned-duration@test',pluginRoot:root,entrypoints:[entry]}])
  expect(runtime.hasHooks('ui.render')).toBe(true)
  expect(runtime.renderHooks.matches({surface:'terminal',component:'TurnDuration',requestId:'x',props:{word:'Baked',durationMs:1}})).toBe(component==='TurnDuration')
}

function BoundRuntime({children}:{children:React.ReactNode}) {
  const version=React.useSyncExternalStore(runtime.renderHooks.subscribe,runtime.renderHooks.getSnapshot)
  const value=React.useMemo(()=>({runtime,version}),[version])
  return <ModsRenderContext value={value}>{children}</ModsRenderContext>
}

async function screen(wrap:(row:React.ReactNode)=>React.ReactNode = row=>row) {
  const chunks: string[]=[]
  const stdout=new Writable({write(chunk,_encoding,done){chunks.push(chunk.toString());done()}})
  Object.assign(stdout,{columns:90,rows:24,isTTY:false})
  const stdin=new PassThrough();Object.assign(stdin,{isTTY:true,setRawMode(){},ref(){},unref(){}})
  const message=createTurnDurationMessage(1)
  const store=createStore(getDefaultAppState())
  const node=<AppStoreContext value={store}><BoundRuntime>{wrap(
    <SystemTextMessage message={message} addMargin={false} verbose={false}/>
  )}</BoundRuntime></AppStoreContext>
  const instance=await render(node,{stdin:stdin as never,stdout:stdout as never,patchConsole:false,exitOnCtrlC:false})
  async function waitFor(check:()=>boolean) {
    const until=Date.now()+2000
    while(!check()&&Date.now()<until)await new Promise<void>(resolve=>setImmediate(resolve))
    expect(check()).toBe(true)
  }
  return {message,chunks,instance,stdin,waitFor,clear(){chunks.length=0},output:()=>chunks.join(''),close(){instance.unmount();instance.cleanup();stdin.destroy();stdout.destroy()}}
}

test('TurnDuration production row reaches its real Worker and replaces the native line', async () => {
  await load("return $.ui.resolve(e).Text({children:'OWNED-DURATION-REPLACED'});")
  const f=await screen()
  try {
    await f.waitFor(()=>f.output().includes('OWNED-DURATION-REPLACED'))
    expect(seen).toContainEqual(expect.objectContaining({surface:'terminal',component:'TurnDuration',requestId:f.message.uuid,props:expect.objectContaining({word:expect.any(String),durationMs:1})}))
    expect(f.message.durationMs).toBe(1)
  } finally {f.close()}
})

test('TurnDuration next rewrites native word and duration inside a decorated tree', async () => {
  await load("const {Box,Text}=$.ui.resolve(e);return Box({flexDirection:'column',children:[Text({children:'OWNED-BEFORE'}),await next({...e,props:{...e.props,word:'OWNED-WORD',durationMs:3000}}),Text({children:'OWNED-AFTER'})]});")
  const f=await screen()
  try {
    await f.waitFor(()=>f.output().includes('OWNED-WORD for 3s'))
    expect(f.output()).toContain('OWNED-BEFORE')
    expect(f.output()).toContain('OWNED-AFTER')
    expect(f.message.durationMs).toBe(1)
  } finally {f.close()}
})


test('completion verbs use the official UTF-16 hash, including unsigned overflow', () => {
  const values: Record<string,string> = {'':'Baked','a':'Brewed','b':'Churned','g':'Worked','00000000-0000-0000-0000-000000000001':'Brewed','😀':'Cogitated'}
  for(const [uuid,word] of Object.entries(values))expect(getTurnCompletionVerb(uuid)).toBe(word)
})

test('an unrelated render matcher keeps the production native row and issues zero render calls', async () => {
  await load("return $.ui.resolve(e).Text({children:'UNRELATED-HOOK'});",'AbovePrompt')
  const f=await screen()
  try {
    await f.waitFor(()=>f.output().includes(getTurnCompletionVerb(f.message.uuid)+' for'))
    expect(seen).toEqual([])
    expect(diagnostics).toEqual([])
    expect(f.output()).not.toContain('UNRELATED-HOOK')
  }finally{f.close()}
})

test('native completion verb remains stable when its row is unmounted and remounted', async () => {
  const f=await screen()
  try {
    const word=getTurnCompletionVerb(f.message.uuid)
    await f.waitFor(()=>f.output().includes(word+' for'))
    f.instance.rerender(null)
    f.clear()
    f.instance.rerender(<AppStoreContext value={createStore(getDefaultAppState())}><SystemTextMessage message={f.message} addMargin={false} verbose={false}/></AppStoreContext>)
    await f.waitFor(()=>f.output().includes(word+' for'))
    expect(f.message.durationMs).toBe(1)
  }finally{f.close()}
})

test('plugins may replace a duration row even when its native display setting is hidden', async () => {
  saveGlobalConfig(value=>({...value,showTurnDuration:false}))
  await load("return $.ui.resolve(e).Text({children:'HIDDEN-NATIVE-REPLACEMENT'});")
  const f=await screen()
  try{await f.waitFor(()=>f.output().includes('HIDDEN-NATIVE-REPLACEMENT'));expect(f.message.durationMs).toBe(1)}finally{f.close()}
})

test('multiple next calls preserve distinct native continuations without editing the transcript', async () => {
  await load("const {Box}=$.ui.resolve(e);return Box({flexDirection:'column',children:[await next({...e,props:{...e.props,word:'FIRST',durationMs:2000}}),await next({...e,props:{...e.props,word:'SECOND',durationMs:4000}})]});")
  const f=await screen()
  try {
    await f.waitFor(()=>f.output().includes('SECOND for 4s'))
    expect(f.output()).toContain('FIRST for 2s')
    expect(f.message.durationMs).toBe(1)
  }finally{f.close()}
})

test('invalid plugin trees fall back to the original production completion row', async () => {
  await load("return {type:'NotAWidget',children:['INVALID-TREE']};")
  const f=await screen()
  try{await f.waitFor(()=>f.output().includes(getTurnCompletionVerb(f.message.uuid)+' for'));expect(f.output()).not.toContain('INVALID-TREE');expect(diagnostics.length).toBeGreaterThan(0)}finally{f.close()}
})

test('live hook publication adds, reloads, and removes the production site', async () => {
  const f=await screen()
  try {
    await f.waitFor(()=>f.output().includes(getTurnCompletionVerb(f.message.uuid)+' for'))
    f.clear()
    await load("return $.ui.resolve(e).Text({children:'HOOK-ADDED'});")
    await f.waitFor(()=>f.output().includes('HOOK-ADDED'))
    f.clear()
    await load("return $.ui.resolve(e).Text({children:'HOOK-RELOADED'});")
    await f.waitFor(()=>f.output().includes('HOOK-RELOADED'))
    f.clear()
    await runtime.reconcile([])
    await f.waitFor(()=>f.output().includes(getTurnCompletionVerb(f.message.uuid)+' for'))
    expect(runtime.renderHooks.matches({surface:'terminal',component:'TurnDuration',requestId:f.message.uuid,props:{}})).toBe(false)
    expect(f.output()).not.toContain('HOOK-RELOADED')
  }finally{f.close()}
})

test('native sites render real Client modules and retain surrounding host continuations', async () => {
  await writeFile(join(root,'surface.ts'),"export default function View(props,s){return s.elements.Text({children:'REAL-CLIENT-'+props.label})}")
  await load("const {Box,Client}=$.ui.resolve(e);return Box({flexDirection:'column',children:[Client({key:'client',module:'./surface.ts',props:{label:'DRAWN'}}),await next({...e,props:{...e.props,word:'AFTER-CLIENT',durationMs:2000}})]});")
  const f=await screen()
  try{await f.waitFor(()=>f.output().includes('REAL-CLIENT-DRAWN'));expect(f.output()).toContain('AFTER-CLIENT for 2s');expect(f.message.durationMs).toBe(1)}finally{f.close()}
})

test('native render viewport comes from the actual terminal context', async () => {
  await load("return await next(e);")
  const f=await screen()
  try{await f.waitFor(()=>seen.length>0);expect(seen[0]).toEqual(expect.objectContaining({viewport:{columns:90,rows:24,isFullscreen:false}}));expect((seen[0]as any).props.onScreen).toBeUndefined()}finally{f.close()}
})

test('painted ScrollBox rows report partial visibility and null outside the viewport', async () => {
  process.env.CLAUDE_CODE_NO_FLICKER='1'
  const scroll=React.createRef<ScrollBoxHandle>()
  await load(`return $.ui.resolve(e).Text({children:${JSON.stringify(['DRAWING-LINE-1','DRAWING-LINE-2','DRAWING-LINE-3'].join('\n'))}});`)
  const f=await screen(row=><ScrollBox ref={scroll} width={90} flexDirection="column" height={3} flexShrink={0}><Box height={2} flexShrink={0}><Text>before</Text></Box>{row}<Box height={6} flexShrink={0}><Text>after</Text></Box></ScrollBox>)
  try {
    await f.waitFor(()=>seen.some((e:any)=>e.props.onScreen?.first===0&&e.props.onScreen?.last===0&&e.props.onScreen?.of===3))
    scroll.current!.scrollTo(3)
    await f.waitFor(()=>seen.some((e:any)=>e.props.onScreen?.first===1&&e.props.onScreen?.last===2&&e.props.onScreen?.of===3))
    scroll.current!.scrollTo(5)
    await f.waitFor(()=>seen.some((e:any)=>e.props.onScreen===null))
  }finally{f.close()}
})

test('frame observers run after the scroll clamp is painted', async () => {
  const scroll=React.createRef<ScrollBoxHandle>()
  const row=React.createRef<DOMElement>()
  const observations:unknown[]=[]
  let unsubscribe:()=>void=()=>{}
  const f=await screen(native=><ScrollBox ref={scroll} width={90} flexDirection="column" height={3}><Box height={2}/><Box ref={row} flexShrink={0} flexDirection="column">{native}<Text>second</Text><Text>third</Text></Box><Box height={6}/></ScrollBox>)
  try{
    await f.waitFor(()=>!!row.current?.yogaNode?.getComputedHeight())
    unsubscribe=subscribeFrame(row.current!,()=>observations.push(getModOnScreen(row.current)))
    scroll.current!.scrollTo(1000)
    await f.waitFor(()=>observations.length>0)
    expect(scroll.current!.getScrollTop()).toBe(8)
    expect(observations.at(-1)).toBeNull()
  }finally{unsubscribe();f.close()}
})


function OwnedInput({children}:{children:React.ReactNode}) {useInput(()=>{});return children}

test('actual native-site Button focus and press retain the Worker callback lease', async () => {
  await load("return $.ui.resolve(e).Button({key:'owned-run',label:'OWNED-RUN',onPress:press=>$.ui.log(JSON.stringify({phase:'pressed',element:press.element,requestId:press.requestId}),{to:'debug'})});",'TurnDuration',"on('ui.focus',async($,e,next)=>{$.ui.log(JSON.stringify({phase:'focus',element:e.element,requestId:e.requestId}),{to:'debug'});return await next(e)});")
  const f=await screen(row=><OwnedInput>{row}</OwnedInput>)
  try {
    await f.waitFor(()=>f.output().includes('OWNED-RUN'))
    f.stdin.write('\t')
    await f.waitFor(()=>seen.some((e:any)=>e.phase==='focus'))
    f.stdin.write('\r')
    await f.waitFor(()=>seen.some((e:any)=>e.phase==='pressed'))
    expect(seen).toContainEqual({phase:'focus',element:'owned-run',requestId:f.message.uuid})
    expect(seen).toContainEqual({phase:'pressed',element:'owned-run',requestId:f.message.uuid})
  }finally{f.close()}
})

test('the hook store matches actual input and publishes host registration removal', async () => {
  const versions:number[]=[]
  const unsubscribe=runtime.renderHooks.subscribe(()=>versions.push(runtime.renderHooks.getSnapshot()))
  const unregister=runtime.registerHostCallback({tier:'user',registration:{id:123,event:'ui.*',matcher:{component:'TurnDuration',props:{word:'ONLY'}},hasCatch:false}},(_$,e,next)=>next(e))
  const input={surface:'terminal',component:'TurnDuration',requestId:'input-specific',props:{word:'ONLY',durationMs:1}}
  try {
    expect(runtime.renderHooks.matches(input)).toBe(true)
    expect(runtime.renderHooks.matches({...input,props:{...input.props,word:'OTHER'}})).toBe(false)
    expect(runtime.renderHooks.matches({...input,component:'AbovePrompt'})).toBe(false)
    unregister()
    expect(runtime.renderHooks.matches(input)).toBe(false)
    expect(versions).toHaveLength(2)
    expect(versions[1]).toBe(versions[0]!+1)
  }finally{unregister();unsubscribe()}
})

test('a site that finishes after its row unmounts cannot paint its obsolete drawing', async () => {
  await load("await $.clock.sleep(60);return $.ui.resolve(e).Text({children:'OBSOLETE-DRAWING'});")
  const f=await screen()
  try {
    await f.waitFor(()=>seen.length>0)
    f.instance.rerender(null)
    f.clear()
    await runtime.settle()
    await new Promise(resolve=>setTimeout(resolve,80))
    expect(f.output()).not.toContain('OBSOLETE-DRAWING')
    expect(runtime.ui.getSnapshot()).toEqual([])
  }finally{f.close()}
})


test('a real Worker cannot introduce viewport-owned onScreen through next', async () => {
  await load("const {Text}=$.ui.resolve(e);try{await next({...e,props:{...e.props,onScreen:{first:0,last:0,of:1}}});return Text({children:'BAD-READONLY-ACCEPTED'})}catch(error){return Text({children:'READONLY-REJECTED '+error.message})}")
  const f=await screen()
  try{await f.waitFor(()=>f.output().includes('READONLY-REJECTED'));expect(f.output().replace(/\s+/g,' ')).toContain('props.onScreen other than the surface reported');expect(f.output()).not.toContain('BAD-READONLY-ACCEPTED')}finally{f.close()}
})

test('a Worker may clone onScreen but cannot change or drop the painted viewport', async () => {
  process.env.CLAUDE_CODE_NO_FLICKER='1'
  const scroll=React.createRef<ScrollBoxHandle>()
  await load("if(e.props.onScreen){await next({...e,props:{...e.props,onScreen:{...e.props.onScreen}}});const {onScreen,...rest}=e.props;try{await next({...e,props:rest});throw Error('dropping accepted')}catch(error){if(!error.message.includes('surface reported'))throw error}try{await next({...e,props:{...e.props,onScreen:{...e.props.onScreen,of:e.props.onScreen.of+1}}});throw Error('changing accepted')}catch(error){if(!error.message.includes('surface reported'))throw error}return $.ui.resolve(e).Text({children:'VIEWPORT-UNCHANGED'})}return await next(e)")
  const f=await screen(row=><ScrollBox ref={scroll} width={90} flexDirection="column" height={4}>{row}<Box height={8}/></ScrollBox>)
  try{await f.waitFor(()=>f.output().includes('VIEWPORT-UNCHANGED'));expect(diagnostics).toEqual([])}finally{f.close()}
})


test('composer presentation redraws its band without redundantly invoking native transcript hooks', async () => {
  await load("return await next(e);",'TurnDuration',"on('ui.render',{component:'AbovePrompt'},async($,e,next)=>{$.ui.log(JSON.stringify(e),{to:'debug'});return await next(e)});")
  const f=await screen()
  const band=await runtime.ui.mount({surface:'terminal',component:'AbovePrompt',requestId:'owned-band',props:{}},{surface:'terminal',render(){},unmount(){}})
  const presentation={columns:90,rows:24,isFullscreen:false,composerEmpty:true,hasDialog:false,keyboardOwned:false}
  try {
    await f.waitFor(()=>seen.some((e:any)=>e.component==='TurnDuration'))
    const nativeCount=()=>seen.filter((e:any)=>e.component==='TurnDuration').length
    const bandCount=()=>seen.filter((e:any)=>e.component==='AbovePrompt').length
    const beforeNative=nativeCount(),beforeBand=bandCount()
    await runtime.ui.render(presentation,{nativeSites:false})
    expect(nativeCount()).toBe(beforeNative)
    expect(bandCount()).toBe(beforeBand+1)
    await runtime.ui.render(presentation)
    expect(nativeCount()).toBe(beforeNative+1)
    expect(bandCount()).toBe(beforeBand+2)
  }finally{await band.dispose();f.close()}
})
