import { afterEach, beforeEach, expect, test } from 'bun:test'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import React, { useRef, useState } from 'react'
import { Readable, Writable } from 'node:stream'
import { ThemeProvider, render } from '../../ink.js'
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
import { mkdir, mkdtemp, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getTheme, THEME_NAMES, type ThemeName } from '../../utils/theme.js'
import officialThemes from '../../services/mods/fixtures/promptThemes289.json'
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
  try {
    if (testConfigRoot !== undefined) await rm(testConfigRoot, { recursive: true, force: true })
  } finally {
    testConfigRoot = undefined
    resetSettingsCache()
    testEnvKeys.forEach((key, i) => {
      if (savedTestEnvironment[i] === undefined) delete process.env[key]
      else process.env[key] = savedTestEnvironment[i]
    })
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

async function mount(initial = '', carry = false, searching = false, footer = false, theme: ThemeName = 'dark', relay?: (edit: TextInputEdit) => void) {
  const stdin = new Input(), stdout = new Output()
  const initialState = {...getDefaultAppState(),...(footer?{replBridgeConnected:true,replBridgeExplicit:true,footerSelection:'bridge' as const}:{})}, store = createStore(initialState)
  const edits: TextInputEdit[] = []
  let frame: FrameEvent | undefined
  let value = initial
  let editor: React.ComponentProps<typeof PromptInput>['insertTextRef']
  function Probe() {
    const [input,setInput] = useState(initial)
    const [mode,setMode] = useState<PromptInputMode>('prompt')
    const [pastedContents,setPastedContents] = useState<Record<number,PastedContent>>({})
    const [vimMode,setVimMode] = useState<VimMode>('INSERT')
    const [helpOpen,setHelpOpen] = useState(false)
    editor = useRef(null)
    value = input
    return <PromptInput debug={false} ideSelection={undefined}
      toolPermissionContext={initialState.toolPermissionContext} setToolPermissionContext={() => {}}
      apiKeyStatus="valid" commands={[]} agents={[]} enableLocalIOCompletions={false}
      isLoading={false} isAssistantResponding={false} verbose={false} messages={[]}
      onAutoUpdaterResult={() => {}} autoUpdaterResult={null} input={input}
      onInputChange={next => {value=next;setInput(next)}} onPromptEdit={edit => {edits.push(structuredClone(edit));if(carry)editor?.current?.carryDecorations(edit);relay?.(edit)}}
      mode={mode} onModeChange={setMode} stashedPrompt={undefined} setStashedPrompt={() => {}}
      submitCount={0} onShowMessageSelector={() => {}} mcpClients={[]}
      pastedContents={pastedContents} setPastedContents={setPastedContents} vimMode={vimMode} setVimMode={setVimMode}
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
  return {stdin,edits,settle,styles,get cursorCell(){return frame?.frame && frame.physicalCursor ? charInCellAt(frame.frame.screen,frame.physicalCursor.x,frame.physicalCursor.y):undefined},get value(){return value},get editor(){return editor?.current as PromptInputHandle | null},dispose(){instance.unmount();instance.cleanup()}}
}

test('mounted prompt handle exposes an application fill immediately before React commits',async()=>{
 const h=await mount('old')
 try{
  h.editor!.setInputWithCursor('A😀B',3)
  expect({text:h.editor!.text,cursor:h.editor!.cursorOffset}).toEqual({text:'A😀B',cursor:3})
  h.editor!.insert('X')
  expect({text:h.editor!.text,cursor:h.editor!.cursorOffset}).toEqual({text:'A😀XB',cursor:4})
  expect(h.edits).toEqual([])
  await h.settle();expect(h.value).toBe('A😀XB')
 }finally{h.dispose()}
})

test('mounted production PromptInput records same-chunk typing and its live cursor, while application fills do not raise',async()=>{
  const h=await mount('a😀b')
  try {
    h.stdin.push('X\x1b[D');await h.settle()
    expect(h.value).toBe('a😀bX')
    expect(h.edits).toEqual([
      {before:{text:'a😀b',cursor:4},after:{text:'a😀bX',cursor:5},key:{key:'X',shift:true}},
      {before:{text:'a😀bX',cursor:5},after:{text:'a😀bX',cursor:4},key:{key:'left'}},
    ])
    expect(h.editor?.cursorOffset).toBe(4)
    h.editor!.setInputWithCursor('app text',3);await h.settle()
    expect(h.value).toBe('app text');expect(h.edits).toHaveLength(2)
  }finally{h.dispose()}
})

test('mounted production PromptInput records bracketed text paste as one editor edit with no invented key',async()=>{
  const h=await mount('ab')
  try {
    h.stdin.push('\x1b[200~中😀\x1b[201~')
    const deadline=Date.now()+1000
    while(h.value!=='ab中😀'&&Date.now()<deadline)await new Promise(resolve=>setImmediate(resolve))
    expect(h.value).toBe('ab中😀')
    expect(h.edits).toEqual([{before:{text:'ab',cursor:2},after:{text:'ab中😀',cursor:5}}])
  }finally{h.dispose()}
})


test('mounted PromptInput paints current decorations and never resurrects them after application fills',async()=>{
  const h=await mount('ab')
  try {
    expect(typeof h.editor?.paintDecorations).toBe('function')
    h.editor!.paintDecorations([{start:0,end:2,color:'red',backgroundColor:'#123456',bold:true,italic:true,underline:true,strikethrough:true}], 'ab');await h.settle()
    expect(h.styles().find(n=>n.styles?.color==='#e5484d'&&n.text==='ab')?.styles).toMatchObject({backgroundColor:'#123456',bold:true,italic:true,underline:true,strikethrough:true})
    h.editor!.setInputWithCursor('xy',2);await h.settle()
    expect(h.styles().some(n=>n.styles?.color==='#e5484d')).toBe(false)
    h.editor!.paintDecorations([{start:0,end:2,color:'red'}],'ab');await h.settle()
    expect(h.styles().some(n=>n.styles?.color==='#e5484d')).toBe(false)
    h.editor!.setInputWithCursor('ab',2);await h.settle()
    expect(h.styles().some(n=>n.styles?.color==='#e5484d')).toBe(false)
    h.editor!.paintDecorations([{start:0,end:2,color:'red'}],'ab');await h.settle()
    expect(h.styles().some(n=>n.styles?.color==='#e5484d')).toBe(true)
    h.editor!.paintDecorations(undefined,'ab');await h.settle()
    expect(h.styles().some(n=>n.styles?.color==='#e5484d')).toBe(false)
  }finally{h.dispose()}
})

test('mounted PromptInput carries paint only through recorded person edits',async()=>{
  const h=await mount('ab',true)
  try {
    expect(typeof h.editor?.carryDecorations).toBe('function')
    h.editor!.paintDecorations([{start:0,end:2,color:'red'}],'ab');await h.settle()
    h.stdin.push('X');await h.settle()
    expect(h.value).toBe('abX')
    expect(h.styles().filter(n=>n.styles?.color==='#e5484d').map(n=>n.text).join('')).toBe('ab')
    h.editor!.insert('application');await h.settle()
    expect(h.styles().some(n=>n.styles?.color==='#e5484d')).toBe(false)
    expect(h.edits).toHaveLength(1)
  }finally{h.dispose()}
})

test('mounted PromptInput excludes the whole cursor grapheme from plugin paint without losing adjacent paint',async()=>{
  const h=await mount('a😀b')
  try {
    expect(typeof h.editor?.paintDecorations).toBe('function')
    h.editor!.setInputWithCursor('a😀b',1)
    h.editor!.paintDecorations([{start:0,end:4,color:'red',bold:true}],'a😀b');await h.settle()
    expect(h.styles().filter(n=>n.styles?.color==='#e5484d').map(n=>n.text).join('')).toBe('ab')
    expect(h.editor!.cursorOffset).toBe(1)
    expect(h.cursorCell).toBe('😀')
    h.editor!.setInputWithCursor('a😀b',4);await h.settle()
    expect(h.styles().filter(n=>n.styles?.color==='#e5484d').map(n=>n.text).join('')).toBe('a😀b')
  }finally{h.dispose()}
})


test('mounted PromptInput keeps history search free of composer plugin paint',async()=>{
 const h=await mount('ab',false,true)
 try{
  h.editor!.paintDecorations([{start:0,end:2,color:'red'}],'ab');await h.settle()
  expect(h.styles().some(n=>n.styles?.color==='#e5484d')).toBe(false)
 }finally{h.dispose()}
})


test('mounted PromptInput paints through the hidden caret while an actual footer item owns focus',async()=>{
 const h=await mount('ab',false,false,true)
 try{
  h.editor!.setInputWithCursor('ab',0)
  h.editor!.paintDecorations([{start:0,end:2,color:'red'}],'ab');await h.settle()
  expect(h.styles().filter(n=>n.styles?.color==='#e5484d').map(n=>n.text).join('')).toBe('ab')
 }finally{h.dispose()}
})


test('mounted PromptInput sends a real edit through its author Worker and paints official theme keys in all six palettes',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'mods-prompt-paint-')))
 const folder=join(root,'plugin');await mkdir(folder)
 const entry=join(folder,'register.ts')
 await writeFile(entry,`export function register(on){on('prompt.edit',async($,e,next)=>{const r=await next(e);await $.clock.sleep(1);return {...r,text:r.text.toUpperCase(),decorations:['skill','effortUltra','autoAcceptShimmer','messageActionsBackground','unknownShortColor'].map((color,start)=>({start,end:start+1,color,backgroundColor:color,bold:true}))}})}`)
 const diagnostics:unknown[]=[]
 // Rendering palettes is independent of the separately tested 50ms edit budget.
 const runtime=createModsRuntime({onDiagnostic:event=>diagnostics.push(event),promptEditBudgetMs:1000})
 try{
  await runtime.reconcile([{name:'paint-probe',storageId:'paint-probe@test',pluginRoot:folder,entrypoints:[entry]}])
  for(const theme of THEME_NAMES){
   const reports:string[]=[]
   const queue=createModPromptEditQueue({
    read:()=>({text:h.editor!.text,cursor:h.editor!.cursorOffset}),
    commit:box=>h.editor!.setInputWithCursor(box.text,box.cursor),
    paint:(paint,text)=>h.editor!.paintDecorations(paint,text),
    carry:edit=>h.editor!.carryDecorations(edit),
    raise:async(edit,signal)=>{const snapshot=runtime.capture();try{return await runModPromptEdit(snapshot,edit,signal)}finally{snapshot.release()}},
    report:reason=>reports.push(reason),
   })
   const h=await mount('abcde',false,false,false,theme,edit=>queue.record(edit))
   try{
    h.stdin.push('x')
    const deadline=Date.now()+1000
    while(h.value!=='ABCDEX'&&Date.now()<deadline)await new Promise(resolve=>setImmediate(resolve))
    await h.settle()
    expect({reports,diagnostics}).toEqual({reports:[],diagnostics:[]})
    expect(h.value).toBe('ABCDEX');expect(h.editor!.cursorOffset).toBe(6)
    expect(h.edits).toEqual([{before:{text:'abcde',cursor:5},after:{text:'abcdex',cursor:6},key:{key:'x'}}])
    for(const [index,key] of ['skill','effortUltra','autoAcceptShimmer'].entries()){
     const color=officialThemes.themes[theme][key as 'skill'|'effortUltra'|'autoAcceptShimmer']
     expect(h.styles().find(n=>n.text==='ABC'[index]&&n.styles?.color===color)?.styles).toMatchObject({color,backgroundColor:color,bold:true})
    }
    expect(h.styles().some(n=>n.text==='D'&&n.styles?.color===getTheme(theme).messageActionsBackground)).toBe(false)
    expect(h.styles().find(n=>n.text==='D'&&n.styles?.bold)?.styles?.backgroundColor).toBeUndefined()
    expect(h.styles().find(n=>n.text==='E'&&n.styles?.bold)?.styles?.color).toBeUndefined()
    expect(reports).toEqual([])
   }finally{queue.dispose();h.dispose()}
  }
  expect(diagnostics).toEqual([])
 }finally{await runtime.dispose();await rm(root,{recursive:true,force:true})}
},10000)

test.each(['replace','append','insert'] as const)('real Worker prompt.fill %s paints runs relative to inserted text and replaces previous paint without an editor event',async mode=>{
 const h=await mount('abc',false,false,true)
 const root=await realpath(await mkdtemp(join(tmpdir(),'mods-mounted-fill-')))
 const entry=join(root,'register.ts')
 await writeFile(entry,`export function register(on){on('tool.call',async($,e)=>{const result=await $.prompt.fill(e.fill);const box=await $.prompt.read();return {result:{...result,box}}})}`)
 const diagnostics:unknown[]=[]
 const composer={
  read:()=>({text:h.editor!.text,cursor:h.editor!.cursorOffset}),
  set:(text:string,cursor:number)=>h.editor!.setInputWithCursor(text,cursor),
  paint:(runs:Parameters<PromptInputHandle['paintDecorations']>[0],text:string)=>h.editor!.paintDecorations(runs,text),
 }
 const runtime=createModsRuntime({onDiagnostic:event=>diagnostics.push(event),services:{prompt:()=>({read:composer.read,fill:input=>fillPromptBox(composer,input)})}})
 try{
  await runtime.bind({cwd:root,surface:'terminal',isInteractive:true,sessionId:'paint-fill'})
  await runtime.reconcile([{name:'fill-probe',storageId:'fill-probe@test',pluginRoot:root,entrypoints:[entry]}])
  h.editor!.setInputWithCursor('abc',1)
  h.editor!.paintDecorations([{start:0,end:3,color:'red'}],'abc');await h.settle()
  expect(h.styles().some(n=>n.styles?.color==='#e5484d')).toBe(true)
  const fill={text:'xy',mode,decorations:[{start:0,end:2,color:'green',backgroundColor:'#123456',bold:true}]}
  const receipt=await runtime.dispatch('tool.call',{tool:'Bash',tool_use_id:'fill-paint',fill},async()=>({result:'core'}))
  await h.settle()
  const text=mode==='replace'?'xy':mode==='append'?'abcxy':'axybc',cursor=mode==='insert'?3:text.length
  expect(receipt).toEqual({result:{isFilled:true,text,cursor,box:{text,cursor}}})
  expect(h.styles().find(n=>n.text==='xy'&&n.styles?.color==='#46a758')?.styles).toMatchObject({backgroundColor:'#123456',bold:true})
  expect(h.styles().some(n=>n.styles?.color==='#e5484d')).toBe(false)
  await runtime.dispatch('tool.call',{tool:'Bash',tool_use_id:'same-fill',fill:{text,mode:'replace'}},async()=>({result:'core'}));await h.settle()
  expect(h.styles().find(n=>n.text==='xy'&&n.styles?.color==='#46a758')?.styles).toMatchObject({backgroundColor:'#123456',bold:true})
  await runtime.dispatch('tool.call',{tool:'Bash',tool_use_id:'empty-fill',fill:{text:'',mode:'append',decorations:[]}},async()=>({result:'core'}));await h.settle()
  expect(h.styles().find(n=>n.text==='xy'&&n.styles?.color==='#46a758')?.styles).toMatchObject({backgroundColor:'#123456',bold:true})
  await runtime.dispatch('tool.call',{tool:'Bash',tool_use_id:'clear-fill',fill:{text,mode:'replace',decorations:[]}},async()=>({result:'core'}));await h.settle()
  expect(h.styles().some(n=>n.text==='xy'&&n.styles?.color==='#46a758')).toBe(false)
  await runtime.dispatch('tool.call',{tool:'Bash',tool_use_id:'unicode-fill',fill:{text:'😀X',mode:'replace',decorations:[{start:1,end:3,color:'green',bold:true}]}},async()=>({result:'core'}));await h.settle()
  expect(h.value).toBe('😀X');expect(h.editor!.cursorOffset).toBe(3)
  expect(h.styles().find(n=>n.text==='😀X'&&n.styles?.color==='#46a758')?.styles).toMatchObject({bold:true})
  expect(h.edits).toEqual([]);expect(diagnostics).toEqual([])
 }finally{h.dispose();await runtime.dispose();await rm(root,{recursive:true,force:true})}
})

test.each(['omit-mode','forged','core-dialog','core-headless','tamper-dialog'] as const)('real Worker prompt.fill keeps mode and core refusal provenance: %s',async kind=>{
 const h=await mount('abc')
 const root=await realpath(await mkdtemp(join(tmpdir(),'mods-mounted-fill-cause-')))
 const caller=join(root,'caller.ts'),policy=join(root,'policy.ts')
 await writeFile(caller,`export function register(on){on('tool.call',async($,e)=>{const result=await $.prompt.fill(e.fill);await $.prompt.read();return {result}})}`)
 await writeFile(policy,`export function register(on){on('prompt.fill',async($,e,next)=>{if(e.text==='omit-mode')return next({text:'xy'});if(e.text==='forged')return {isFilled:false,refusal:'no_composer'};const r=await next(e);return e.text==='tamper-dialog'?{...r,refusal:'no_composer'}:r})}`)
 const blocked=kind==='core-dialog'||kind==='tamper-dialog',headless=kind==='core-headless'
 const diagnostics:unknown[]=[]
 const runtime=createModsRuntime({onDiagnostic:event=>diagnostics.push(event),services:{prompt:()=>({
  read:()=>({text:h.editor!.text,cursor:h.editor!.cursorOffset}),isBlocked:()=>blocked,
  fill:input=>fillPromptBox({read:()=>({text:h.editor!.text,cursor:h.editor!.cursorOffset}),set:(text,cursor)=>h.editor!.setInputWithCursor(text,cursor),paint:(runs,text)=>h.editor!.paintDecorations(runs,text)},input),
 })}})
 try{
  await runtime.bind({cwd:root,surface:headless?null:'terminal',isInteractive:!headless,sessionId:'fill-cause'})
  await runtime.reconcile([{name:'fill-caller',storageId:'fill-caller@test',pluginRoot:root,entrypoints:[caller]},{name:'fill-policy',storageId:'fill-policy@test',pluginRoot:root,entrypoints:[policy]}])
  const receipt=await runtime.dispatch('tool.call',{tool:'Bash',tool_use_id:'fill-cause',fill:{text:kind,mode:'append'}},async()=>({result:'core'}))
  await h.settle()
  const box=headless?{text:'',cursor:0}:kind==='omit-mode'?{text:'abcxy',cursor:5}:{text:'abc',cursor:3}
  const refusal=kind==='core-dialog'?'dialog':headless?'no_composer':undefined
  expect(receipt).toEqual({result:{isFilled:kind==='omit-mode',...box,...(refusal===undefined?{}:{refusal})}})
  expect(h.value).toBe(kind==='omit-mode'?'abcxy':'abc');expect(h.edits).toEqual([]);expect(diagnostics).toEqual([])
 }finally{h.dispose();await runtime.dispose();await rm(root,{recursive:true,force:true})}
})
