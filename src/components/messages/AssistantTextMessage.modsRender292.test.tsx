import { afterEach, beforeEach, expect, test } from 'bun:test'
import React from 'react'
import { PassThrough, Writable } from 'node:stream'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { render } from '../../ink.js'
import { Message } from '../Message.js'
import type { ModRenderInput } from '../../services/mods/ui.js'
import { BLACK_CIRCLE } from '../../constants/figures.js'
import { createAssistantMessage, EMPTY_LOOKUPS, normalizeMessages } from '../../utils/messages.js'
import { createModsRuntime } from '../../services/mods/runtime.js'
import { ModsRenderContext } from '../../context/modsRenderContext.js'
import { AppStoreContext, getDefaultAppState } from '../../state/AppState.js'
import { createStore } from '../../state/store.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'

const envKeys = ['HOME','CLAUDE_CONFIG_DIR','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR','CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR','CLAUDE_CODE_NO_FLICKER']
let original: (string | undefined)[]
let root: string
let runtime: ReturnType<typeof createModsRuntime>
const seen: ModRenderInput[] = []
const diagnostics: unknown[] = []
beforeEach(async () => {
  original = envKeys.map(key => process.env[key])
  root = await realpath(await mkdtemp(join(tmpdir(), 'mods-assistant-test-')))
  for (const key of envKeys.slice(0,5)) process.env[key] = root
  process.env.ANTHROPIC_API_KEY = 'owned-placeholder'
  for (const key of envKeys.slice(6)) delete process.env[key]
  process.env.CLAUDE_CODE_NO_FLICKER = '0'
  resetSettingsCache()
  diagnostics.length = 0
  seen.length = 0
  runtime = createModsRuntime({ onDiagnostic(event) { diagnostics.push(event) }, services: { uiLog(_plugin,text) { seen.push(JSON.parse(text)) } } })
  await runtime.bind({ cwd:root,surface:'terminal',isInteractive:true,sessionId:'owned-assistant' })
})
afterEach(async () => {
  try { await runtime.dispose(); await rm(root,{recursive:true,force:true}) }
  finally { envKeys.forEach((key,i)=>{if(original[i]===undefined)delete process.env[key];else process.env[key]=original[i]});resetSettingsCache() }
})

async function load(body: string, component = 'AssistantMessage', registrations = '') {
  const entry=join(root,'register.mjs')
  await writeFile(entry,`export function register(on){on('ui.render',{component:${JSON.stringify(component)}},async($,e,next)=>{ $.ui.log(JSON.stringify(e),{to:'debug'}); ${body} });${registrations}}`)
  await runtime.reconcile([{name:'owned-assistant',storageId:'owned-assistant@test',pluginRoot:root,entrypoints:[entry]}])
  expect(runtime.hasHooks('ui.render')).toBe(true)
  expect(runtime.renderHooks.matches({surface:'terminal',component:'AssistantMessage',requestId:'x',props:{text:'owned',isFirstOfReply:true}})).toBe(component==='AssistantMessage')
}

function BoundRuntime({children}:{children:React.ReactNode}) {
  const version=React.useSyncExternalStore(runtime.renderHooks.subscribe,runtime.renderHooks.getSnapshot)
  const value=React.useMemo(()=>({runtime,version}),[version])
  return <ModsRenderContext value={value}>{children}</ModsRenderContext>
}

async function screen(wrap:(row:React.ReactNode)=>React.ReactNode = row=>row, text='\n<context>hidden</context>\n  ORIGINAL **REPLY**  \n') {
  const chunks: string[]=[]
  const stdout=new Writable({write(chunk,_encoding,done){chunks.push(chunk.toString());done()}})
  Object.assign(stdout,{columns:90,rows:24,isTTY:false})
  const stdin=new PassThrough();Object.assign(stdin,{isTTY:true,setRawMode(){},ref(){},unref(){}})
  const message=normalizeMessages([createAssistantMessage({content:text})])[0]!
  const store=createStore(getDefaultAppState())
  const node=(content=message.message.content, first=true)=><AppStoreContext value={store}><BoundRuntime>{wrap(
    <Message message={{...message,message:{...message.message,content}}} lookups={EMPTY_LOOKUPS} tools={[]} commands={[]} addMargin={false} verbose={false} shouldShowDot={first} shouldAnimate={false} inProgressToolUseIDs={new Set()} progressMessagesForMessage={[]} isTranscriptMode={false} isStatic={false}/>
  )}</BoundRuntime></AppStoreContext>
  const instance=await render(node(),{stdin:stdin as never,stdout:stdout as never,patchConsole:false,exitOnCtrlC:false})
  async function waitFor(check:()=>boolean) {
    const until=Date.now()+2000
    while(!check()&&Date.now()<until)await new Promise<void>(resolve=>setImmediate(resolve))
    expect(check()).toBe(true)
  }
  return {message,chunks,instance,stdin,waitFor,rerender(text:string,first=true){instance.rerender(node([{type:"text",text,citations:[]}],first))},clear(){chunks.length=0},output:()=>chunks.join(''),close(){instance.unmount();instance.cleanup();stdin.destroy();stdout.destroy()}}
}


test('actual assistant router gives its Worker cleaned display text and the message UUID', async () => {
  await load("return $.ui.resolve(e).Text({children:'OWNED-ASSISTANT-REPLACED'});")
  const f=await screen()
  try {
    await f.waitFor(()=>f.output().includes('OWNED-ASSISTANT-REPLACED'))
    expect(seen).toContainEqual(expect.objectContaining({component:'AssistantMessage',requestId:f.message.uuid,props:{text:'  ORIGINAL **REPLY**  \n',isFirstOfReply:true}}))
    expect(seen.some(e=>e.requestId===f.message.message.id)).toBe(false)
    expect(f.message.message.content[0]).toEqual({type:'text',text:'\n<context>hidden</context>\n  ORIGINAL **REPLY**  \n'})
    expect(diagnostics).toEqual([])
  } finally {f.close()}
})

test('next rewrites Markdown and the first-reply dot in the production formatter only', async () => {
  await load("const {Box,Text}=$.ui.resolve(e); return Box({flexDirection:'column',children:[Text({children:'OWNED-BEFORE'}),await next({...e,props:{...e.props,text:'**OWNED-NATIVE**',isFirstOfReply:false}}),Text({children:'OWNED-AFTER'})]});")
  const f=await screen()
  try {
    await f.waitFor(()=>f.output().includes('OWNED-NATIVE'))
    expect(f.output()).toContain('OWNED-BEFORE');expect(f.output()).toContain('OWNED-AFTER')
    expect(f.output()).not.toContain('**OWNED-NATIVE**')
    expect(f.output()).not.toContain(BLACK_CIRCLE)
    expect(JSON.stringify(f.message)).not.toContain('OWNED-NATIVE')
    expect(diagnostics).toEqual([])
  } finally {f.close()}
})

test('separate native continuations keep their own rewritten text and dot state', async () => {
  await load("const {Box}=$.ui.resolve(e);return Box({flexDirection:'column',children:[await next({...e,props:{...e.props,text:'OWNED-FIRST',isFirstOfReply:false}}),await next({...e,props:{...e.props,text:'OWNED-SECOND',isFirstOfReply:true}})]});")
  const f=await screen()
  try {
    await f.waitFor(()=>f.output().includes('OWNED-FIRST')&&f.output().includes('OWNED-SECOND'))
    expect(f.output()).toContain(BLACK_CIRCLE);expect(diagnostics).toEqual([])
  } finally {f.close()}
})

test('input updates redraw through the live site with the same message UUID', async () => {
  await load("return $.ui.resolve(e).Text({children:'OWNED-VIEW '+e.props.text+' '+e.props.isFirstOfReply});")
  const f=await screen()
  try {
    await f.waitFor(()=>f.output().includes('OWNED-VIEW'))
    f.clear();f.rerender('<cc-memory>UPDATED</cc-memory>',false)
    await f.waitFor(()=>f.output().includes('OWNED-VIEW UPDATED false'))
    expect(seen).toContainEqual(expect.objectContaining({requestId:f.message.uuid,props:{text:'UPDATED',isFirstOfReply:false}}))
    expect(diagnostics).toEqual([])
  } finally {f.close()}
})

test('a replacement may hide an assistant row without changing its saved text', async () => {
  await load("return $.ui.resolve(e).Text({children:'OWNED-HIDDEN'});")
  const f=await screen()
  try {
    await f.waitFor(()=>f.output().includes('OWNED-HIDDEN'))
    f.clear(); await load("return $.ui.resolve(e).Box({children:[]});")
    await f.waitFor(()=>seen.length>1)
    expect(f.output()).not.toContain('ORIGINAL');expect(JSON.stringify(f.message)).toContain('ORIGINAL')
  } finally {f.close()}
})

test.each([
 ["return {type:'OwnedInvalidTree'};", 'invalid'],
 ["return next({...e,props:{...e.props,isSummary:true}});", 'summary'],
 ["return next({...e,props:{...e.props,text:42}});", 'text'],
 ["return next({...e,props:{...e.props,isFirstOfReply:'yes'}});", 'first'],
])('bad drawing or next metadata falls back to the ordinary native row (%s)', async (body,kind) => {
  await load(body)
  const f=await screen()
  try {
    await f.waitFor(()=>diagnostics.length>0&&f.output().includes('ORIGINAL'))
    expect(f.output()).not.toContain('hidden')
    expect(f.output()).not.toContain('OwnedInvalidTree')
    if(kind==='summary')expect(JSON.stringify(diagnostics)).toContain('props.isSummary other than the engine drew')
    if(kind==='text')expect(JSON.stringify(diagnostics)).toContain('props.text that is a number, not a string')
    if(kind==='first')expect(JSON.stringify(diagnostics)).toContain('props.isFirstOfReply that is a string, not a boolean')
    expect(JSON.stringify(f.message)).toContain('hidden')
  } finally {f.close()}
})

test('unmatched hook leaves the ordinary native row and does not call its Worker', async () => {
  await load("return $.ui.resolve(e).Text({children:'UNRELATED'});",'AbovePrompt')
  const f=await screen()
  try {
    await f.waitFor(()=>f.output().includes('ORIGINAL'))
    expect(seen).toEqual([]);expect(diagnostics).toEqual([])
    expect(f.output()).not.toContain('UNRELATED')
  } finally {f.close()}
})

test.each(['<context>PRIVATE</context>', 'No response requested.', 'Prompt is too long'])('hook precedes native hidden/error handling: %s', async text => {
  await load("return $.ui.resolve(e).Text({children:'OWNED-BEFORE-NATIVE-FILTER'});")
  const f=await screen(undefined,text)
  try {
    await f.waitFor(()=>f.output().includes('OWNED-BEFORE-NATIVE-FILTER'))
    expect(seen).toContainEqual(expect.objectContaining({requestId:f.message.uuid}))
    expect(f.message.message.content[0]).toEqual({type:'text',text})
    expect(diagnostics).toEqual([])
  } finally {f.close()}
})

test('unmodified next retains the native API error sentinel and saved raw text', async () => {
  await load('return next(e);')
  const f=await screen(undefined,'Prompt is too long')
  try {
    await f.waitFor(()=>f.output().includes('Context limit reached'))
    expect(f.output()).not.toContain('Prompt is too long')
    expect(f.message.message.content[0]).toEqual({type:'text',text:'Prompt is too long'})
    expect(diagnostics).toEqual([])
  } finally {f.close()}
})
