import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { tmpdir } from 'node:os'
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
import { writeFile, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { KeybindingProvider } from '../../keybindings/KeybindingContext.js'
import { DEFAULT_BINDINGS } from '../../keybindings/defaultBindings.js'
import { parseBindings } from '../../keybindings/parser.js'
import type { KeybindingContextName, ParsedKeystroke } from '../../keybindings/types.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { mkdir } from 'node:fs/promises'
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

function Keybindings({children}:{children:React.ReactNode}) {
 const pending=useRef<ParsedKeystroke[]|null>(null),registry=useRef(new Map())
 const contexts=useRef(new Set<KeybindingContextName>(['Global','Chat']))
 return <KeybindingProvider bindings={parseBindings(DEFAULT_BINDINGS)} pendingChordRef={pending} pendingChord={null}
  setPendingChord={value=>{pending.current=value}} activeContexts={contexts.current}
  registerActiveContext={value=>{contexts.current.add(value)}} unregisterActiveContext={value=>{contexts.current.delete(value)}}
  handlerRegistryRef={registry}>{children}</KeybindingProvider>
}

async function mount(initial = 'old', vim = false, initialVim: VimMode = 'INSERT', relay?: (edit: TextInputEdit) => void) {
  const previousEditorMode = getGlobalConfig().editorMode
  saveGlobalConfig(config => ({...config,editorMode:vim?'vim':'normal'}))
  const theme: ThemeName = 'dark', carry = false, footer = false
  const stdin = new Input(), stdout = new Output()
  const initialState = {...getDefaultAppState(),...(footer?{replBridgeConnected:true,replBridgeExplicit:true,footerSelection:'bridge' as const}:{})}, store = createStore(initialState)
  const edits: TextInputEdit[] = []
  let frame: FrameEvent | undefined
  let value = initial
  let isSearching = false
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
    const [searching,setSearching] = useState(false)
    isSearching=searching
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
      isSearchingHistory={searching} setIsSearchingHistory={setSearching} helpOpen={helpOpen} setHelpOpen={setHelpOpen}
      insertTextRef={editor} />
  }
  const instance = await render(<AppStoreContext value={store}><ThemeProvider initialState={theme}><Keybindings><Probe /></Keybindings></ThemeProvider></AppStoreContext>, {
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
  return {stdin,edits,settle,styles,boundaries,get searching(){return isSearching},async send(chunk:string){stdin.push(chunk);await settle()},get mode(){return currentMode},get vim(){return currentVim},get committed(){return committed},async applyBeforeKey(chunk:string,apply:()=>void){beforeKey=apply;stdin.push(chunk);await settle()},get cursorCell(){return frame?.frame && frame.physicalCursor ? charInCellAt(frame.frame.screen,frame.physicalCursor.x,frame.physicalCursor.y):undefined},get value(){return value},get editor(){return editor?.current as PromptInputHandle | null},dispose(){instance.unmount();instance.cleanup();saveGlobalConfig(config=>({...config,editorMode:previousEditorMode}))}}
}


async function seedHistory() {
 const folder=getClaudeConfigHomeDir();await mkdir(folder,{recursive:true})
 await writeFile(join(folder,'history.jsonl'),JSON.stringify({display:'HISTORY target ENTRY',pastedContents:{},timestamp:1,project:process.cwd(),sessionId:'semantic-key-fixture'})+'\n')
}
async function waitFor(h:Awaited<ReturnType<typeof mount>>,text:string) {
 const deadline=Date.now()+1000
 while(h.editor!.text!==text&&Date.now()<deadline)await new Promise(resolve=>setImmediate(resolve))
 await h.settle()
}

test.each([false,true])('actual PromptInput history opens before the next semantic key in one stdin read: vim=%s',async vim=>{
 await seedHistory();const h=await mount('old',vim)
 try {
  await h.send('\x12target')
  await waitFor(h,'HISTORY target ENTRY')
  expect(h.searching).toBe(true)
  expect(h.editor!.text).toBe('HISTORY target ENTRY')
  expect(h.editor!.cursorOffset).toBe(8)
  expect(h.edits).toEqual([])
 }finally{h.dispose()}
})

test('actual PromptInput history cancel restores composer focus before the next semantic key in one read',async()=>{
 await seedHistory();const h=await mount('old')
 try {
  await h.send('\x12');await h.send('target');await waitFor(h,'HISTORY target ENTRY')
  expect(h.editor!.text).toBe('HISTORY target ENTRY');expect(h.edits).toEqual([])
  await h.send('\x03z')
  expect(h.searching).toBe(false)
  expect({text:h.editor!.text,cursor:h.editor!.cursorOffset}).toEqual({text:'oldz',cursor:4})
  expect(h.edits).toEqual([{before:{text:'old',cursor:3},after:{text:'oldz',cursor:4},key:{key:'z'}}])
 }finally{h.dispose()}
})

test('actual PromptInput history accept commits its preview before the next key in one read',async()=>{
 await seedHistory();const h=await mount('old')
 try {
  await h.send('\x12');await h.send('target');await waitFor(h,'HISTORY target ENTRY')
  expect(h.editor!.text).toBe('HISTORY target ENTRY');expect(h.edits).toEqual([])
  await h.send('\x1b[27uz')
  expect(h.searching).toBe(false)
  expect({text:h.editor!.text,cursor:h.editor!.cursorOffset}).toEqual({text:'HISTORY ztarget ENTRY',cursor:9})
  expect(h.edits).toEqual([{before:{text:'HISTORY target ENTRY',cursor:8},after:{text:'HISTORY ztarget ENTRY',cursor:9},key:{key:'z'}}])
 }finally{h.dispose()}
})
