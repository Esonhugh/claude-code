import { expect, test } from 'bun:test'
import React, { useState } from 'react'
import { Readable, Writable } from 'node:stream'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ThemeProvider, render } from '../ink.js'
import { createModsRuntime } from '../services/mods/runtime.js'
import { createModPromptEditQueue, runModPromptEdit } from '../services/mods/promptEdit.js'
import { AppStoreContext, getDefaultAppState } from '../state/AppState.js'
import { createStore } from '../state/store.js'
import type { TextInputEdit } from '../types/textInputTypes.js'
import TextInput from './TextInput.js'
import VimTextInput from './VimTextInput.js'

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

test('mounted production TextInput forwards real typing and cursor moves to the editor receipt', async () => {
  const stdin = new Input(), stdout = new Output()
  const edits: TextInputEdit[] = []
  let text = 'a😀b'
  function Probe() {
    const [value, setValue] = useState(text)
    const [cursor, setCursor] = useState(text.length)
    text = value
    return <TextInput value={value} cursorOffset={cursor} onChangeCursorOffset={setCursor}
      onChange={next => {setValue(next); return next}} onEdit={edit => edits.push(structuredClone(edit))}
      focus showCursor columns={80} />
  }
  const instance = await render(<AppStoreContext value={createStore(getDefaultAppState())}><ThemeProvider><Probe /></ThemeProvider></AppStoreContext>, {
    stdin: stdin as never, stdout: stdout as never, patchConsole: false, exitOnCtrlC: false,
  })
  try {
    stdin.push('X\x1b[D')
    for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve))
    expect(text).toBe('a😀bX')
    expect(edits).toEqual([
      {before:{text:'a😀b',cursor:4},after:{text:'a😀bX',cursor:5},key:{key:'X',shift:true}},
      {before:{text:'a😀bX',cursor:5},after:{text:'a😀bX',cursor:4},key:{key:'left'}},
    ])
  } finally { instance.unmount(); instance.cleanup() }
})

test('mounted production TextInput sends a real edit through the author Worker and adopts its rewrite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-mounted-edit-'))
  const folder = join(root, 'plugin')
  await mkdir(folder)
  const entry = join(folder, 'register.ts')
  await writeFile(entry, `export function register(on) {on('prompt.edit',async ($,e,next)=>{const r=await next(e);return {...r,text:r.text.toUpperCase()}})}`)
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic: event => diagnostics.push(event)})
  const stdin = new Input(), stdout = new Output()
  let box = {text:'',cursor:0}
  let commit = (_next: typeof box) => {}
  const queue = createModPromptEditQueue({
    read: () => box,
    commit: next => commit(next),
    raise: async (edit, signal) => {
      const snapshot = runtime.capture()
      try { return await runModPromptEdit(snapshot, edit, signal) }
      finally { snapshot.release() }
    },
    report: reason => diagnostics.push(reason),
  })
  let instance: Awaited<ReturnType<typeof render>> | undefined
  try {
    await runtime.reconcile([{name:'edit-probe',storageId:'edit-probe@test',pluginRoot:folder,entrypoints:[entry]}])
    function Probe() {
      const [value, setValue] = useState('')
      const [cursor, setCursor] = useState(0)
      commit = next => {box=next;setValue(next.text);setCursor(next.cursor)}
      return <TextInput value={value} cursorOffset={cursor} onChangeCursorOffset={next => {box={...box,cursor:next};setCursor(next)}}
        onChange={next => {box={...box,text:next};setValue(next);return next}}
        onEdit={edit => queue.record(edit)} focus showCursor columns={80} />
    }
    instance = await render(<AppStoreContext value={createStore(getDefaultAppState())}><ThemeProvider><Probe /></ThemeProvider></AppStoreContext>, {
      stdin: stdin as never, stdout: stdout as never, patchConsole: false, exitOnCtrlC: false,
    })
    stdin.push('a😀b')
    const deadline = Date.now() + 1000
    while (box.text !== 'A😀B' && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
    expect(box).toEqual({text:'A😀B',cursor:4})
    expect(diagnostics).toEqual([])
  } finally {
    queue.dispose(); instance?.unmount(); instance?.cleanup()
    await runtime.dispose(); await rm(root,{recursive:true,force:true})
  }
})


test('mounted Vim input relays delegated typing and arrows but keeps native Normal commands out of prompt.edit',async()=>{
 const stdin=new Input(),stdout=new Output(),edits:TextInputEdit[]=[]
 let box={text:'ab',cursor:2}
 let mode:string='INSERT'
 function Probe(){
  const [value,setValue]=useState('ab'),[cursor,setCursor]=useState(2)
  return <VimTextInput value={value} cursorOffset={cursor} onChange={next=>{box={...box,text:next};setValue(next);return next}}
   onChangeCursorOffset={next=>{box={...box,cursor:next};setCursor(next)}} onEdit={edit=>edits.push(structuredClone(edit))} onModeChange={next=>{mode=next}}
   focus showCursor columns={80} />
 }
 const instance=await render(<AppStoreContext value={createStore(getDefaultAppState())}><ThemeProvider><Probe /></ThemeProvider></AppStoreContext>,{stdin:stdin as never,stdout:stdout as never,patchConsole:false,exitOnCtrlC:false})
 async function input(key:string){
  stdin.push(key)
  if(key==='\x1b'){const deadline=Date.now()+1000;while(mode!=='NORMAL'&&Date.now()<deadline)await new Promise(resolve=>setImmediate(resolve));expect(mode).toBe('NORMAL')}
  for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve))
 }
 try{
  await input('x');expect(box).toEqual({text:'abx',cursor:3})
  expect(edits).toEqual([{before:{text:'ab',cursor:2},after:{text:'abx',cursor:3},key:{key:'x'}}])
  await input('\x1b');expect(box).toEqual({text:'abx',cursor:2});expect(edits).toHaveLength(1)
  await input('x');expect(box).toEqual({text:'ab',cursor:1});expect(edits).toHaveLength(1)
  await input('\x1b[D');expect(box).toEqual({text:'ab',cursor:0})
  expect(edits).toHaveLength(1)
  await input('\x05');expect(box).toEqual({text:'ab',cursor:2})
  expect(edits[1]).toEqual({before:{text:'ab',cursor:0},after:{text:'ab',cursor:2},key:{key:'e',ctrl:true}})
  await input('\x1bb');expect(box).toEqual({text:'ab',cursor:0})
  expect(edits[2]).toEqual({before:{text:'ab',cursor:2},after:{text:'ab',cursor:0},key:{key:'left',meta:true}})
  expect(edits).toHaveLength(3)
 }finally{instance.unmount();instance.cleanup()}
})
