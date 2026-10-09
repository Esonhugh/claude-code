import { expect, test } from 'bun:test'
import chalk from 'chalk'
import React, { useEffect, useSyncExternalStore } from 'react'
import { Readable, Writable } from 'node:stream'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Terminal } from '@xterm/headless'
import { ModsPane } from './ModsPane.js'
import { createModsRuntime } from '../services/mods/runtime.js'
import { render, ThemeProvider, useStdin, type DOMElement } from '../ink.js'
import { getTheme } from '../utils/theme.js'
import type {DOMNode} from '../ink/dom.js'
import instances from '../ink/instances.js'
import { nodeCache } from '../ink/node-cache.js'
import { ClockContext } from '../ink/components/ClockContext.js'

class Output extends Writable {
  columns = 160
  rows = 30
  isTTY = false
  bytes: Buffer[] = []
  _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) {
    this.bytes.push(Buffer.from(chunk))
    done()
  }
}
class Input extends Readable {
  isTTY = true
  isRaw = false
  _read() {}
  setRawMode(value: boolean) { this.isRaw = value; return this }
  ref() { return this }
  unref() { return this }
}
function EnableInput() {
  const {setRawMode} = useStdin()
  useEffect(() => { setRawMode(true); return () => setRawMode(false) }, [setRawMode])
  return null
}

test('Worker Button children paint and form one press target for pointer and Enter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'button-children-ink-'))
  const diagnostics: unknown[] = [], errors: unknown[] = [], logs: string[] = []
  const presentation = {columns:160, rows:30, isFullscreen:true, composerEmpty:true, hasDialog:false, keyboardOwned:false}
  const runtime = createModsRuntime({onDiagnostic:e=>diagnostics.push(e),services:{
    uiPresentation:()=>presentation,uiLog:(_plugin,text)=>logs.push(text),
  }})
  const stdout = new Output(), stdin = new Input()
  const colorLevel = chalk.level
  chalk.level = 3
  let app: Awaited<ReturnType<typeof render>> | undefined
  let time = 0
  const clock = { now: () => time, subscribe: () => () => {}, setTickInterval: () => {},
    setTimeout: () => () => {} }
  const until = async (predicate:()=>boolean, description:string) => {
    const deadline = Date.now()+1500
    while (!predicate() && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10))
    expect(errors).toEqual([])
    expect(predicate(),description).toBe(true)
  }
  try {
    const entry = join(root,'register.ts')
    await writeFile(entry,[
      'export function register(on) {',
      "on('session.start',async($,e,next)=>{await $.ui.open({id:'children',focus:true});return next(e)});",
      "on('ui.press',async($,e,next)=>{await $.ui.log('dispatch:'+e.element);return next(e)});",
      "on('ui.render',{component:'Pane'},($,e)=>{const {Button,Text}=$.ui.resolve(e);return Button({",
      "key:'save',label:'accessible name',children:['Save ',Text({dimColor:true,children:'2m'})],",
      "onPress:async press=>{await $.ui.log('callback:'+press.element)}",
      '})}); }',
    ].join('\n'))
    await runtime.bind({cwd:root,surface:'terminal',isInteractive:true,sessionId:'button-children-ink'})
    await runtime.reconcile([{name:'children',storageId:'children@test',pluginRoot:root,entrypoints:[entry]}])
    expect(diagnostics).toEqual([])
    expect(runtime.ui.getSnapshot()[0]).toMatchObject({visible:true,tree:{type:'Button'}})
    function Consumer() {
      const pane = useSyncExternalStore(runtime.ui.subscribe,runtime.ui.getSnapshot)[0]!
      if (!pane.visible || pane.shown === false) return <EnableInput/>
      return <><EnableInput/><ModsPane pane={pane} canFocus
        onInteract={(pane,drawing,callback,kind,element,value)=>runtime.ui.interact(pane.id,drawing,callback,kind,element,value)}
        onClose={async()=>{}}
        onFocus={(pane,element)=>runtime.ui.focus(pane.owner,{requestId:pane.id,
          ...(element===undefined?{}:{element}),origin:{kind:'person'}},presentation)}
        onScroll={async()=>({})} onError={e=>errors.push(e)}/></>
    }
    app = await render(<ClockContext.Provider value={clock}><ThemeProvider initialState="dark"><Consumer/></ThemeProvider></ClockContext.Provider>,{
      stdout:stdout as never,stdin:stdin as never,patchConsole:false,exitOnCtrlC:false,
    })
    const getInk = () => instances.get(stdout as never) as unknown as {
      rootNode:DOMElement;setAltScreenActive(active:boolean,mouseTracking?:boolean):void
    }
    const text = (node:DOMNode):string => node.nodeName==='#text'?node.nodeValue:node.childNodes.map(text).join('')
    const findDim = ():DOMElement|undefined => {
      let found:DOMElement|undefined
      const walk = (node:DOMElement) => {
        if (node.nodeName==='ink-virtual-text' && text(node)==='2m') found=node
        for (const child of node.childNodes) if (child.nodeName!=='#text') walk(child)
      }
      const ink=getInk()
      if (!ink) return undefined
      walk(ink.rootNode)
      return found
    }
    await until(()=>findDim()!==undefined,'held Text remains an inline style node')
    const dim=findDim()!
    expect(String(dim.textStyles?.color)).toBe(getTheme('dark').inactive)
    let painted:DOMElement|undefined=dim
    while (painted && !nodeCache.has(painted)) painted=painted.parentNode
    expect(painted?.nodeName).toBe('ink-text')
    expect(text(painted!)).toBe('[ Save 2m ]')
    const rect=nodeCache.get(painted!)!
    const x=rect.x+text(painted!).indexOf('2m'), y=rect.y
    const terminal = new Terminal({cols:160,rows:30,allowProposedApi:true})
    try {
      await new Promise<void>(resolve=>terminal.write(Buffer.concat(stdout.bytes),resolve))
      const rows=Array.from({length:terminal.rows},(_,y)=>terminal.buffer.active.getLine(terminal.buffer.active.baseY+y)?.translateToString(true)??'')
      expect(rows.join('\n')).toContain('[ Save 2m ]')
      expect(rows.join('\n')).not.toContain('accessible name')
      const physicalY=rows.findIndex(row=>row.includes('[ Save 2m ]'))
      const physicalX=rows[physicalY]!.indexOf('2m')
      const line=terminal.buffer.active.getLine(terminal.buffer.active.baseY+physicalY)!
      const rgb=getTheme('dark').inactive.match(/^rgb\((\d+),(\d+),(\d+)\)$/)!.slice(1).map(Number)
      const inactiveRGB=(rgb[0]!<<16)|(rgb[1]!<<8)|rgb[2]!
      expect(line.getCell(physicalX)?.getChars()).toBe('2')
      expect(line.getCell(physicalX)?.isFgRGB()).toBe(true)
      expect(line.getCell(physicalX)?.getFgColor()).toBe(inactiveRGB)
      expect(line.getCell(physicalX-2)?.getFgColor()).not.toBe(inactiveRGB)
    } finally { terminal.dispose() }
    getInk().setAltScreenActive(true,true)
    time = 300
    stdin.push('\x1b[<0;'+(x+1)+';'+(y+1)+'M'+'\x1b[<0;'+(x+1)+';'+(y+1)+'m')
    await until(()=>logs.filter(x=>x==='callback:save').length===1,'child click reaches the one Button callback')
    expect(logs).toEqual(['dispatch:save','callback:save'])
    expect(runtime.ui.getSnapshot()[0]!.focusedElement).toBeUndefined()
    stdin.push('\t\r')
    await until(()=>logs.filter(x=>x==='callback:save').length===2,'Enter reaches the focused Button callback')
    expect(logs).toEqual(['dispatch:save','callback:save','dispatch:save','callback:save'])
    expect(runtime.ui.getSnapshot()[0]).toMatchObject({focused:true,focusedElement:'save'})
    expect(diagnostics).toEqual([])
  } catch (error) {
    await writeFile(join(tmpdir(),`mods-button-children-paint-${process.pid}-${Date.now()}.json`),JSON.stringify({error:String(error),errors:errors.map(String),diagnostics,output:Buffer.concat(stdout.bytes).toString()},null,2))
    throw error
  } finally {
    chalk.level = colorLevel
    app?.unmount()
    app?.cleanup()
    await runtime.dispose()
    await rm(root,{recursive:true,force:true})
  }
})
