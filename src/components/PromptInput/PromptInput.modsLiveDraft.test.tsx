import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { beforeEach, afterEach, expect, test } from 'bun:test'
import React, { useLayoutEffect, useRef, useState } from 'react'
import { Readable, Writable } from 'node:stream'
import { ThemeProvider, render, useInput } from '../../ink.js'
import { AppStoreContext, getDefaultAppState } from '../../state/AppState.js'
import { createStore } from '../../state/store.js'
import type { PastedContent } from '../../utils/config.js'
import instances from '../../ink/instances.js'
import type { FrameEvent } from '../../ink/frame.js'
import { charInCellAt } from '../../ink/screen.js'
import type { DOMElement, DOMNode } from '../../ink/dom.js'
import { createModPromptEditQueue, runModPromptEdit } from '../../services/mods/promptEdit.js'
import { createModsRuntime } from '../../services/mods/runtime.js'
import { fillPromptBox } from '../../services/mods/promptAdapter.js'
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import type { ThemeName } from '../../utils/theme.js'
import type { TextInputEdit, PromptInputMode, PromptInputHandle, VimMode } from '../../types/textInputTypes.js'
import PromptInput from './PromptInput.js'


const testEnvKeys = [
  'HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
]
let testConfigRoot: string | undefined
let savedTestEnvironment: (string | undefined)[] = []
beforeEach(async () => {
  savedTestEnvironment = testEnvKeys.map(key => process.env[key])
  testConfigRoot = await realpath(await mkdtemp(join(tmpdir(), 'mods-test-config-')))
  process.env.HOME = testConfigRoot
  process.env.CLAUDE_CONFIG_DIR = join(testConfigRoot, 'config')
  process.env.XDG_CONFIG_HOME = join(testConfigRoot, 'xdg-config')
  process.env.XDG_CACHE_HOME = join(testConfigRoot, 'xdg-cache')
  process.env.XDG_STATE_HOME = join(testConfigRoot, 'xdg-state')
  process.env.ANTHROPIC_API_KEY = 'sk-test-placeholder'
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  delete process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  resetSettingsCache()
})
afterEach(async () => {
  resetSettingsCache()
  testEnvKeys.forEach((key, i) => {
    if (savedTestEnvironment[i] === undefined) delete process.env[key]
    else process.env[key] = savedTestEnvironment[i]
  })
  if (testConfigRoot !== undefined) {
    await rm(testConfigRoot, { recursive: true, force: true })
    testConfigRoot = undefined
  }
})

class Input extends Readable {
  isTTY = true
  _read() {}
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
class Output extends Writable {
  columns = 80
  rows = 24
  isTTY = true
  _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void) { done() }
}

async function mount(initial = 'old', vim = false, initialVim: VimMode = 'INSERT', relay?: (edit: TextInputEdit) => void) {
  const previousEditorMode = getGlobalConfig().editorMode
  saveGlobalConfig(config => ({...config,editorMode:vim?'vim':'normal'}))
  const theme: ThemeName = 'dark', carry = false, searching = false, footer = false
  const stdin = new Input(), stdout = new Output()
  const initialState = {...getDefaultAppState(),...(footer?{replBridgeConnected:true,replBridgeExplicit:true,footerSelection:'bridge' as const}:{})}, store = createStore(initialState)
  const edits: TextInputEdit[] = []
  let frame: FrameEvent | undefined
  let value = initial
  let currentMode: PromptInputMode = 'prompt', currentVim = initialVim
  let committed: {text:string;cursor:number;mode:PromptInputMode;vim:VimMode} = {text:initial,cursor:initial.length,mode:currentMode,vim:currentVim}
  let beforeKey: (() => void) | undefined
  const boundaries: {committed:typeof committed,live:{text:string,cursor:number}}[] = []
  let editor: React.ComponentProps<typeof PromptInput>['insertTextRef']
  function Probe() {
    const [input,setInput] = useState(initial)
    const [mode,setMode] = useState<PromptInputMode>('prompt')
    const [pastedContents,setPastedContents] = useState<Record<number,PastedContent>>({})
    const [vimMode,setVimMode] = useState<VimMode>(initialVim)
    const [helpOpen,setHelpOpen] = useState(false)
    editor = useRef(null)
    value = input
    useLayoutEffect(() => {committed={text:input,cursor:editor?.current?.cursorOffset??input.length,mode,vim:vimMode}}, [input,mode,vimMode])
    useInput(() => {if(beforeKey){const apply=beforeKey;beforeKey=undefined;apply();boundaries.push({committed:{...committed},live:{text:editor!.current!.text,cursor:editor!.current!.cursorOffset}})}},{capture:true})
    return <PromptInput debug={false} ideSelection={undefined}
      toolPermissionContext={initialState.toolPermissionContext} setToolPermissionContext={() => {}}
      apiKeyStatus="valid" commands={[]} agents={[]} enableLocalIOCompletions={false}
      isLoading={false} isAssistantResponding={false} verbose={false} messages={[]}
      onAutoUpdaterResult={() => {}} autoUpdaterResult={null} input={input}
      onInputChange={next => {value=next;setInput(next)}} onPromptEdit={edit => {edits.push(structuredClone(edit));if(carry)editor?.current?.carryDecorations(edit);relay?.(edit)}}
      mode={mode} onModeChange={next=>{currentMode=next;setMode(next)}} stashedPrompt={undefined} setStashedPrompt={() => {}}
      submitCount={0} onShowMessageSelector={() => {}} mcpClients={[]}
      pastedContents={pastedContents} setPastedContents={setPastedContents} vimMode={vimMode} setVimMode={next=>{currentVim=next;setVimMode(next)}}
      showBashesDialog={false} setShowBashesDialog={() => {}} onExit={() => {}}
      getToolUseContext={() => {throw new Error('This input fixture does not execute a query')}}
      onSubmit={async () => {throw new Error('This input fixture does not submit')}}
      isSearchingHistory={searching} setIsSearchingHistory={() => {}} helpOpen={helpOpen} setHelpOpen={setHelpOpen}
      insertTextRef={editor} />
  }
  const instance = await render(<AppStoreContext value={store}><ThemeProvider initialState={theme}><Probe /></ThemeProvider></AppStoreContext>, {
    stdin: stdin as never, stdout: stdout as never, patchConsole:false, exitOnCtrlC:false, onFrame: event => {frame=event},
  })
  async function settle() {
    for(let i=0;i<12;i++) await new Promise(resolve=>setImmediate(resolve))
    // The test renderer commits synchronously before cursor layout effects.
    instances.get(stdout as never)?.onRender()
  }
  function styles() {
    const ink=instances.get(stdout as never) as unknown as {rootNode:DOMElement}
    const found: {text:string;styles:DOMElement['textStyles']}[]=[]
    const text=(node:DOMNode):string=>node.nodeName==='#text'?node.nodeValue:node.childNodes.map(text).join('')
    const walk=(node:DOMNode)=>{if(node.nodeName==='#text')return;if(node.textStyles)found.push({text:text(node),styles:node.textStyles});node.childNodes.forEach(walk)}
    walk(ink.rootNode);return found
  }
  await settle()
  return {stdin,edits,settle,styles,boundaries,get mode(){return currentMode},get vim(){return currentVim},get committed(){return committed},async applyBeforeKey(chunk:string,apply:()=>void){beforeKey=apply;stdin.push(chunk);await settle()},get cursorCell(){return frame?.frame && frame.physicalCursor ? charInCellAt(frame.frame.screen,frame.physicalCursor.x,frame.physicalCursor.y):undefined},get value(){return value},get editor(){return editor?.current as PromptInputHandle | null},dispose(){instance.unmount();instance.cleanup();saveGlobalConfig(config=>({...config,editorMode:previousEditorMode}))}}
}


const typingReceipt = [{before:{text:'A😀B',cursor:3},after:{text:'A😀xB',cursor:4},key:{key:'x'}}]
test.each([
 [false,'INSERT','A😀B',3,'x','A😀xB',4,'INSERT',typingReceipt],
 [true,'INSERT','A😀B',3,'x','A😀xB',4,'INSERT',typingReceipt],
 [true,'INSERT','A😀B',3,'\x1b[27ux','AB',1,'NORMAL',[]],
 [true,'NORMAL','ABC',1,'x','AC',1,'NORMAL',[]],
 [true,'NORMAL','ABC',1,'iZ','AZBC',2,'INSERT',[]],
] as const)('actual PromptInput app fill before uncommitted %s %s key %s %i %s reads its live composer',async(vim,initialVim,text,cursor,key,after,offset,nextVim,edits)=>{
 const h=await mount('old',vim,initialVim)
 try{
  await h.applyBeforeKey(key,()=>h.editor!.setInputWithCursor(text,cursor))
  expect(h.boundaries).toEqual([{committed:{text:'old',cursor:3,mode:'prompt',vim:initialVim},live:{text,cursor}}])
  expect({text:h.editor!.text,cursor:h.editor!.cursorOffset,mode:h.mode,vim:h.vim}).toEqual({text:after,cursor:offset,mode:'prompt',vim:nextVim})
  expect(h.edits).toEqual([...edits])
 }finally{h.dispose()}
})

test.each([false,true])('actual PromptInput %s mode prefix uses a newly emptied precommit draft',async vim=>{
 const h=await mount('old',vim)
 try{
  await h.applyBeforeKey('!',()=>h.editor!.setInputWithCursor('',0))
  expect(h.boundaries[0]).toEqual({committed:{text:'old',cursor:3,mode:'prompt',vim:'INSERT'},live:{text:'',cursor:0}})
  expect({text:h.editor!.text,cursor:h.editor!.cursorOffset,mode:h.mode}).toEqual({text:'',cursor:0,mode:'bash'})
  expect(h.edits).toEqual([])
 }finally{h.dispose()}
})


test.each([false,true])('actual PromptInput %s keeps committed fill and subsequent typing in sync',async vim=>{
 const h=await mount('old',vim)
 try{
  h.editor!.setInputWithCursor('ABC',1)
  await h.settle()
  expect(h.committed).toEqual({text:'ABC',cursor:1,mode:'prompt',vim:'INSERT'})
  h.stdin.push('xy');await h.settle()
  expect({text:h.editor!.text,cursor:h.editor!.cursorOffset}).toEqual({text:'AxyBC',cursor:3})
  expect(h.edits).toEqual([{before:{text:'ABC',cursor:1},after:{text:'AxyBC',cursor:3}}])
 }finally{h.dispose()}
})

test.each([false,true])('actual Worker fill and editor %s next key before React commits keep receipt and paint on the live draft',async vim=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'mods-live-fill-key-')))
 const entry=join(root,'register.ts')
 await writeFile(entry,`export function register(on){on('tool.call',async($,e)=>{if(e.inspect)return {result:await $.store.get('edit')};const filled=await $.prompt.fill(e.fill);return {result:{filled,box:await $.prompt.read()}}});on('prompt.edit',async($,e,next)=>{await $.store.set('edit',e);const r=await next(e);return {...r,decorations:[{start:0,end:r.text.length,color:'green',bold:true}]}})}`)
 const h=await mount('old',vim,'INSERT',edit=>queue.record(edit))
 const diagnostics:unknown[]=[],reports:string[]=[]
 const boundaries: {committed:typeof h.committed,live:{text:string,cursor:number}}[]=[]
 let sendNextKey=true
 const composer={read:()=>({text:h.editor!.text,cursor:h.editor!.cursorOffset}),set:(text:string,cursor:number)=>h.editor!.setInputWithCursor(text,cursor),paint:(runs:Parameters<PromptInputHandle['paintDecorations']>[0],text:string)=>h.editor!.paintDecorations(runs,text)}
 const runtime=createModsRuntime({onDiagnostic:event=>diagnostics.push(event),services:{prompt:()=>({read:composer.read,fill:input=>{
  const result=fillPromptBox(composer,input)
  if(sendNextKey){sendNextKey=false;boundaries.push({committed:{...h.committed},live:composer.read()});h.stdin.push('x');h.stdin.emit('readable')}
  return result
 }})}})
 const queue=createModPromptEditQueue({read:composer.read,commit:box=>composer.set(box.text,box.cursor),paint:composer.paint,carry:edit=>h.editor!.carryDecorations(edit),raise:async(edit,signal)=>{const snapshot=runtime.capture();try{return await runModPromptEdit(snapshot,edit,signal)}finally{snapshot.release()}},report:reason=>reports.push(reason)})
 try{
  await runtime.bind({cwd:root,surface:'terminal',isInteractive:true,sessionId:'live-composer'})
  await runtime.reconcile([{name:'live-fill',storageId:'live-fill@test',pluginRoot:root,entrypoints:[entry]}])
  const receipt=await runtime.dispatch('tool.call',{tool:'Bash',tool_use_id:'fill-before-key',fill:{text:'ABC',mode:'replace',decorations:[{start:0,end:3,color:'red'}]}},async()=>({result:'core'}))
  expect(boundaries).toEqual([{committed:{text:'old',cursor:3,mode:'prompt',vim:'INSERT'},live:{text:'ABC',cursor:3}}])
  expect(receipt).toEqual({result:{filled:{isFilled:true,text:'ABCx',cursor:4},box:{text:'ABCx',cursor:4}}})
  const expected={before:{text:'ABC',cursor:3},after:{text:'ABCx',cursor:4},key:{key:'x'}}
  expect(h.edits).toEqual([expected])
  let returned:unknown
  const deadline=Date.now()+1000
  while(returned===undefined&&Date.now()<deadline){returned=((await runtime.dispatch('tool.call',{tool:'Bash',tool_use_id:'inspect',inspect:true},async()=>({result:'core'}))) as {result:unknown}).result;await new Promise(resolve=>setImmediate(resolve))}
  expect(returned).toEqual({text:'ABC',cursor:3,start:3,end:3,inputText:'x',key:{key:'x'},origin:{kind:'composer'}})
  while(h.styles().filter(n=>n.styles?.color==='#46a758').map(n=>n.text).join('')!=='ABCx'&&Date.now()<deadline)await new Promise(resolve=>setImmediate(resolve))
  await h.settle()
  expect({text:h.editor!.text,cursor:h.editor!.cursorOffset,mode:h.mode,vim:h.vim}).toEqual({text:'ABCx',cursor:4,mode:'prompt',vim:'INSERT'})
  expect(h.styles().filter(n=>n.styles?.color==='#46a758').map(n=>n.text).join('')).toBe('ABCx')
  expect(h.styles().some(n=>n.styles?.color==='#e5484d')).toBe(false)
  expect({diagnostics,reports}).toEqual({diagnostics:[],reports:[]})
 }finally{queue.dispose();h.dispose();await runtime.dispose();await rm(root,{recursive:true,force:true})}
})
