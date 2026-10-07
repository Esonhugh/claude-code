import { afterEach, beforeEach, expect, test } from 'bun:test'
import React from 'react'
import { PassThrough, Writable } from 'node:stream'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { render } from '../../ink.js'
import { Message } from '../Message.js'
import type { ModRenderInput } from '../../services/mods/ui.js'
import stripAnsi from 'strip-ansi'
import { BLACK_CIRCLE } from '../../constants/figures.js'
import { createAssistantMessage, EMPTY_LOOKUPS, normalizeMessages } from '../../utils/messages.js'
import { createModsRuntime } from '../../services/mods/runtime.js'
import { ModsRenderContext } from '../../context/modsRenderContext.js'
import { AppStoreContext, getDefaultAppState } from '../../state/AppState.js'
import { createStore } from '../../state/store.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'

const envKeys = ['HOME','CLAUDE_CONFIG_DIR','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR','CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR','CLAUDE_CODE_NO_FLICKER','CLAUDE_CODE_MODEL_CAPABILITIES','CLAUDE_CODE_ENTRYPOINT','CLAUDE_CODE_CHILD_SESSION']
let original: (string | undefined)[]
let root: string
let runtime: ReturnType<typeof createModsRuntime>
const seen: ModRenderInput[] = []
const diagnostics: unknown[] = []
beforeEach(async () => {
  original = envKeys.map(key => process.env[key])
  root = await realpath(await mkdtemp(join(tmpdir(), 'mods-summary-test-')))
  for (const key of envKeys.slice(0,5)) process.env[key] = root
  process.env.ANTHROPIC_API_KEY = 'owned-placeholder'
  for (const key of envKeys.slice(6)) delete process.env[key]
  process.env.CLAUDE_CODE_NO_FLICKER = '0'
  resetSettingsCache()
  diagnostics.length = 0
  seen.length = 0
  runtime = createModsRuntime({ onDiagnostic(event) { diagnostics.push(event) }, services: { uiLog(_plugin,text) { seen.push(JSON.parse(text)) } } })
  await runtime.bind({ cwd:root,surface:'terminal',isInteractive:true,sessionId:'owned-summary' })
})
afterEach(async () => {
  try { await runtime.dispose(); await rm(root,{recursive:true,force:true}) }
  finally { envKeys.forEach((key,i)=>{if(original[i]===undefined)delete process.env[key];else process.env[key]=original[i]});resetSettingsCache() }
})

async function load(body: string, component = 'AssistantMessage', registrations = '') {
  const entry=join(root,'register.mjs')
  await writeFile(entry,`export function register(on){on('ui.render',{component:${JSON.stringify(component)}},async($,e,next)=>{ $.ui.log(JSON.stringify(e),{to:'debug'}); ${body} });${registrations}}`)
  await runtime.reconcile([{name:'owned-summary',storageId:'owned-summary@test',pluginRoot:root,entrypoints:[entry]}])
  expect(runtime.hasHooks('ui.render')).toBe(true)
  expect(runtime.renderHooks.matches({surface:'terminal',component:'AssistantMessage',requestId:'x',props:{text:'owned',isFirstOfReply:true}})).toBe(component==='AssistantMessage')
}

function BoundRuntime({children}:{children:React.ReactNode}) {
  const version=React.useSyncExternalStore(runtime.renderHooks.subscribe,runtime.renderHooks.getSnapshot)
  const value=React.useMemo(()=>({runtime,version}),[version])
  return <ModsRenderContext value={value}>{children}</ModsRenderContext>
}

const narrationSignature = Buffer.from([0x12,13,0x0a,11,0x42,9,...new TextEncoder().encode('narration')]).toString('base64')

async function screen(options: {thinking?:string;signature?:string;model?:string;transcript?:boolean;verbose?:boolean;width?:number}={}) {
  const chunks: string[]=[]
  const stdout=new Writable({write(chunk,_encoding,done){chunks.push(chunk.toString());done()}})
  Object.assign(stdout,{columns:90,rows:24,isTTY:false})
  const stdin=new PassThrough();Object.assign(stdin,{isTTY:true,setRawMode(){},ref(){},unref(){}})
  const raw=createAssistantMessage({content:[{type:'thinking',thinking:options.thinking??'  <context>PRIVATE</context>\n<cc-memory>SUMMARY **BODY**</cc-memory>  ',signature:options.signature??narrationSignature}]})
  const normalized=normalizeMessages([raw])[0]!
  const message={...normalized,message:{...normalized.message,model:options.model??'claude-sonnet-4-6'}}
  const original=JSON.stringify(message)
  const state=getDefaultAppState()
  const store=createStore({...state,settings:{...state.settings,syntaxHighlightingDisabled:true,...(options.width===undefined?{}:{maxProseWidth:options.width})}})
  const node=(first=true)=><AppStoreContext value={store}><BoundRuntime>
    <Message message={message} lookups={EMPTY_LOOKUPS} tools={[]} commands={[]} addMargin={false} verbose={options.verbose??false} shouldShowDot={first} shouldAnimate={false} inProgressToolUseIDs={new Set()} progressMessagesForMessage={[]} isTranscriptMode={options.transcript??false} isStatic={false} lastThinkingBlockId="different:0"/>
  </BoundRuntime></AppStoreContext>
  const instance=await render(node(),{stdin:stdin as never,stdout:stdout as never,patchConsole:false,exitOnCtrlC:false})
  async function waitFor(check:()=>boolean) {
    const until=Date.now()+2000
    while(!check()&&Date.now()<until)await new Promise<void>(resolve=>setImmediate(resolve))
    expect(check()).toBe(true)
  }
  return {message,original,waitFor,rerender(first:boolean){instance.rerender(node(first))},output:()=>stripAnsi(chunks.join('')),close(){instance.unmount();instance.cleanup();stdin.destroy();stdout.destroy()}}
}

test.each([false,true])('actual signed summary reaches the Worker in transcript=%s even when past thinking is hidden',async transcript=>{
  await load("return $.ui.resolve(e).Text({children:'OWNED-SUMMARY-REPLACED'});")
  const f=await screen({transcript})
  try {
    await f.waitFor(()=>f.output().includes('OWNED-SUMMARY-REPLACED'))
    expect(seen).toContainEqual(expect.objectContaining({requestId:f.message.uuid,component:'AssistantMessage',props:{text:'SUMMARY **BODY**',isFirstOfReply:true,isSummary:true}}))
    expect(JSON.stringify(f.message)).toBe(f.original)
    expect(f.output()).not.toContain('·');expect(diagnostics).toEqual([])
  }finally{f.close()}
})

test('native summary next preserves Markdown, the faint hint and independent first-reply state',async()=>{
  await load("const {Box,Text}=$.ui.resolve(e);return Box({flexDirection:'column',children:[Text({children:'BEFORE'}),await next({...e,props:{...e.props,text:'**OWNED-NATIVE**',isFirstOfReply:false}}),Text({children:'AFTER'})]});")
  const f=await screen()
  try {
    await f.waitFor(()=>f.output().includes('OWNED-NATIVE'))
    expect(f.output()).toContain('OWNED-NATIVE ·\u00a0summary');expect(f.output()).toContain('BEFORE');expect(f.output()).toContain('AFTER')
    expect(f.output()).not.toContain('**OWNED-NATIVE**');expect(f.output()).not.toContain(BLACK_CIRCLE);expect(JSON.stringify(f.message)).toBe(f.original)
    expect(diagnostics).toEqual([])
  }finally{f.close()}
})

test('each next continuation keeps its own summary text and dot without changing metadata',async()=>{
  await load("const {Box}=$.ui.resolve(e);return Box({flexDirection:'column',children:[await next({...e,props:{...e.props,text:'FIRST',isFirstOfReply:false}}),await next({...e,props:{...e.props,text:'SECOND',isFirstOfReply:true}})]});")
  const f=await screen()
  try {
    await f.waitFor(()=>f.output().includes('SECOND'))
    expect(f.output()).toContain('FIRST ·\u00a0summary');expect(f.output()).toContain(BLACK_CIRCLE+' SECOND ·\u00a0summary')
    expect(diagnostics).toEqual([])
  }finally{f.close()}
})

test.each(['delete','false','string'])('summary metadata is read only (%s) and failure draws its native row',async variant=>{
  const operation=variant==='delete'?"const props={...e.props};delete props.isSummary;return next({...e,props});":variant==='false'?"return next({...e,props:{...e.props,isSummary:false}});":"return next({...e,props:{...e.props,isSummary:'yes'}});"
  await load(operation)
  const f=await screen()
  try {
    await f.waitFor(()=>diagnostics.length>0&&f.output().includes('SUMMARY BODY'))
    expect(f.output()).toContain('·\u00a0summary');expect(f.output()).not.toContain('PRIVATE')
    expect(JSON.stringify(diagnostics)).toContain('props.isSummary');expect(JSON.stringify(f.message)).toBe(f.original)
  }finally{f.close()}
})

test.each([false,true])('unsigned private thinking never enters the summary hook, verbose=%s',async verbose=>{
  await load("return $.ui.resolve(e).Text({children:'UNEXPECTED-HOOK'});")
  const f=await screen({signature:'not a signature',thinking:'PRIVATE THINKING',verbose})
  try {
    if(verbose)await f.waitFor(()=>f.output().includes('PRIVATE THINKING'))
    else await new Promise(resolve=>setTimeout(resolve,30))
    expect(seen).toEqual([]);expect(diagnostics).toEqual([]);expect(f.output()).not.toContain('UNEXPECTED-HOOK')
    if(!verbose)expect(f.output()).not.toContain('PRIVATE THINKING')
  }finally{f.close()}
})

test('empty narration stays out of the summary hook',async()=>{
  await load("return $.ui.resolve(e).Text({children:'UNEXPECTED-HOOK'});")
  const f=await screen({thinking:'  \n  '})
  try {
    await new Promise(resolve=>setTimeout(resolve,30));expect(seen).toEqual([]);expect(f.output()).not.toContain('UNEXPECTED-HOOK');expect(diagnostics).toEqual([])
  }finally{f.close()}
})

test.each([
 ['claude-sonnet-4-6',undefined,true],
 ['claude-opus-5-5',undefined,false],
 ['claude-opus-5-5','-quizzical_shore',true],
 ['claude-sonnet-4-6','quizzical_shore',false],
])('native summary hint follows model capability for %s (%s)',async(model,capabilities,visible)=>{
  if(capabilities!==undefined)process.env.CLAUDE_CODE_MODEL_CAPABILITIES=capabilities
  await load('return next(e);')
  const f=await screen({model})
  try {
    await f.waitFor(()=>f.output().includes('SUMMARY BODY'))
    expect(f.output().includes('·\u00a0summary')).toBe(visible);expect(diagnostics).toEqual([])
  }finally{f.close()}
})


test.each([
 ['prose','ONE **BODY**','ONE BODY ·\u00a0summary'],
 ['code','```text\nCODE BODY\n```','·\u00a0summary'],
 ['table','| LEFT | RIGHT |\n| --- | --- |\n| VALUE | OTHER |','·\u00a0summary'],
 ['table then prose','| LEFT | RIGHT |\n| --- | --- |\n| VALUE | OTHER |\n\nAFTER TABLE','AFTER TABLE ·\u00a0summary'],
])('unmatched summary renders the native hint exactly once after %s',async(_kind,thinking,tail)=>{
 await load('return next(e);','AbovePrompt')
 const f=await screen({thinking})
 try {
  await f.waitFor(()=>f.output().includes(tail));expect(f.output().split('·\u00a0summary').length-1).toBe(1)
  expect(seen).toEqual([]);expect(diagnostics).toEqual([])
 }finally{f.close()}
})

test('prose width caps summary wrapping while fenced code keeps the wider terminal',async()=>{
 await load('return next(e);')
 const code='CODE_'+'X'.repeat(60)
 const f=await screen({thinking:'OWNED PROSE '+('words '.repeat(25))+'\n\n```text\n'+code+'\n```',width:40})
 try {
  await f.waitFor(()=>f.output().includes('summary'))
  const lines=f.output().split('\n').filter(line=>line.includes('words'))
  expect(lines.length).toBeGreaterThan(2)
  expect(lines.every(line=>line.length<=42)).toBe(true)
  expect(f.output()).toContain(code);expect(JSON.stringify(f.message)).toBe(f.original)
 }finally{f.close()}
})

test('native summary preserves leading display spaces and wraps its hint at the same 40-column boundary',async()=>{
 await load('return next(e);')
 const f=await screen({thinking:'<cc-memory> OWNED_SUMMARY_BODY passthrough </cc-memory>',width:40})
 try {
  await f.waitFor(()=>f.output().includes('summary'))
  expect(f.output()).toContain(BLACK_CIRCLE+'  OWNED_SUMMARY_BODY passthrough\n  ·\u00a0summary')
  expect(JSON.stringify(f.message)).toBe(f.original)
 }finally{f.close()}
})
