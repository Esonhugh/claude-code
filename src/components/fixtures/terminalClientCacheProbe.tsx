import { expect, mock } from 'bun:test'
import React from 'react'
import { Writable, Readable } from 'node:stream'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as actualInk from '../../ink.js'
import { createModsRuntime } from '../../services/mods/runtime.js'
import instances from '../../ink/instances.js'
import { TerminalSizeContext } from '../../ink/components/TerminalSizeContext.js'
import type { Color } from '../../ink/styles.js'
import { getTheme } from '../../utils/theme.js'
import { charInCellAt } from '../../ink/screen.js'
import type { DOMElement } from '../../ink/dom.js'
import type { DOMNode } from '../../ink/dom.js'

let workerStarts = 0
const NativeWorker = globalThis.Worker
globalThis.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {super(url,options);workerStarts++}
}
let throwLeaf = false
let rejectedLeaf = 0
const RealText = actualInk.BaseText
mock.module('../../ink.js', () => ({ ...actualInk, BaseText: (props: React.ComponentProps<typeof RealText>) => {
  if (throwLeaf && String(props.children).startsWith('terminal leaf')) {
    rejectedLeaf++
    throw Error('terminal consumer rejected the leaf')
  }
  return React.createElement(RealText, props)
} }))
const { ModsPane } = await import('../ModsPane.js')
const { ModsAbovePrompt } = await import('../ModsAbovePrompt.js')
const { FullscreenLayout } = await import('../FullscreenLayout.js')
const { useTerminalSize } = await import('../../hooks/useTerminalSize.js')
class Output extends Writable {
  columns = 160; rows = 40; isTTY = false; output = ''
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) { this.output += chunk.toString(); callback() }
}
class Input extends Readable {
  isTTY = true; isRaw = false
  _read() {}
  setRawMode(value: boolean) { this.isRaw = value; return this }
  ref() { return this } unref() { return this }
}
const scenario = process.argv[2] ?? 'pane'
const mode = scenario === 'above' ? 'above' : 'pane'
const root = await mkdtemp(join(tmpdir(), 'mods-terminal-cache-'))
const faults: any[] = []; const diagnostics: unknown[] = []; const errors: unknown[] = []
const output = new Output(); const input = new Input()
const frames: string[][] = []
let inactive:Color
const runtime = createModsRuntime({ onDiagnostic: value => diagnostics.push(value), services: {
 uiPresentation: () => ({columns:160,rows:40,isFullscreen:true,composerEmpty:true,hasDialog:false,keyboardOwned:false}),
 uiStatus: (_name, text) => { if (text !== undefined) faults.push(JSON.parse(text)) },
} })
let inkRoot: Awaited<ReturnType<typeof actualInk.createRoot>> | undefined
let global = { columns:160,rows:40,conversationColumns:111 }
let region = { columns:160,rows:40 }
let prop: any = { a:1,b:2 }
let width = 24
const drawn = 0
const texts = () => {
 const ink = instances.get(output as never) as unknown as {rootNode: DOMNode}
 const walk = (node: DOMNode): string => node.nodeName === '#text' ? node.nodeValue : node.childNodes.map(walk).join('')
 return ink ? walk(ink.rootNode) : ''
}
const settle = async () => { for(let i=0;i<8;i++) await new Promise(resolve => setTimeout(resolve,10)) }
const waitFor = async (check: () => boolean) => {
 for(let i=0;i<50&&!check();i++) await new Promise(resolve => setTimeout(resolve,10))
 if(!check()) console.error({texts:texts(),faults,errors,diagnostics,output:output.output.slice(-1000),rejectedLeaf}); expect(check()).toBe(true)
}
function handedTree(raw: any): any {
 if(raw.type==='Client'&&raw.props.key==='surface')return {...raw,props:{...raw.props,width,props:prop}}
 return Array.isArray(raw.children)?{...raw,children:raw.children.map(handedTree)}:raw
}
function Consumer() {
 inactive=getTheme(actualInk.useTheme()[0]).inactive as Color
 const live = React.useSyncExternalStore(runtime.ui.subscribe,runtime.ui.getSnapshot)[0]
 return <TerminalSizeContext value={{...region,global} as any}>
  {mode === 'above' ? <ModsAbovePrompt ui={runtime.ui} hasSurvey={false} isWorking={false} view={{}} canFocus onError={error=>errors.push(error)} /> : live && <ModsPane pane={{...live,tree:handedTree(live.tree),drawing:live.drawing! + drawn}} onInteract={async()=>{}} onClose={async()=>{}} onFocus={async()=>({})} onScroll={async()=>({})} onError={error=>errors.push(error)} />}
 </TerminalSizeContext>
}
const paint = async () => { inkRoot!.render(<Consumer/>); await settle() }
try {
 const entry = join(root,'register.ts')
 await writeFile(entry, `export function register(on) {
  on('session.start',async($,e,next)=>{await $.ui.open({id:'panel'});return next(e)});
  on('ui.render',($,e)=>{const {Client}=$.ui.resolve(e);return ${scenario==='sibling'?`$.ui.resolve(e).Box({children:[Client({key:'surface',module:'./surface.ts',width:24,height:3,props:${JSON.stringify(prop)}}),Client({key:'sibling',module:'./sibling.ts',width:24,height:3})]})`:`Client({key:'surface',module:'./surface.ts',width:24,height:3,props:${JSON.stringify(prop)}})`}});
  on('ui.fault',async($,e,next)=>{await $.ui.status(JSON.stringify(e));return next(e)});
  on('ui.message',()=>({props:{a:9,b:9}}));
 }`)
 await writeFile(join(root,'surface.ts'), `export default function Surface(props,s) {
  if(s.state===undefined){s.setState(0);s.onKey(()=>s.setState(s.state+1))}
  return s.elements.Text({children:'terminal leaf:'+JSON.stringify(props)+':state='+s.state});
 }`)
 await writeFile(join(root,'sibling.ts'),`export default function Surface(_,s){if(s.state===undefined){s.setState(0);s.onKey(()=>s.setState(s.state+1))}return s.elements.Text({children:'sibling leaf:state='+s.state})}`)
 await runtime.bind({cwd:root,surface:'terminal',isInteractive:true,sessionId:'terminal-cache'})
 await runtime.reconcile([{name:'owner',storageId:'owner@test',pluginRoot:root,entrypoints:[entry]}])
 expect(diagnostics).toEqual([])
 inkRoot = await actualInk.createRoot({stdout:output as never,stdin:input as never,patchConsole:false,exitOnCtrlC:false,onFrame({frame}) {
  if(!frame)return
  const rows=Array.from({length:frame.screen.height},(_,y)=>Array.from({length:frame.screen.width},(_,x)=>charInCellAt(frame.screen,x,y)).join(''))
  frames.push(rows)
 }})
 await paint(); await waitFor(()=>texts().includes('terminal leaf'))
 if(scenario==='layout') {
  const measured = new Map<string,unknown>()
  function Size({name}:{name:string}) {measured.set(name,useTerminalSize());return <actualInk.Text>{name}</actualInk.Text>}
  inkRoot.render(<FullscreenLayout scrollable={<Size name="conversation"/>} bottom={<Size name="bottom"/>} sidebarWidth={20} sidebarPane={<Size name="sidebar"/>} dockWidth={40} dockPane={<Size name="dock"/>} inlinePane={<Size name="inline"/>}/>)
  await settle()
  const signature={columns:160,rows:40,conversationColumns:100}
  expect(measured.get('conversation')).toEqual({columns:100,rows:40,global:signature})
  expect(measured.get('inline')).toEqual({columns:100,rows:40,global:signature})
  expect(measured.get('sidebar')).toEqual({columns:20,rows:40,global:signature})
  expect(measured.get('dock')).toEqual({columns:39,rows:40,global:signature})
  expect(measured.get('bottom')).toEqual({columns:160,rows:40,global:signature})
  console.log(JSON.stringify({scenario,status:'passed'}))
 } else {
 const beforeFaultFrame=frames.length
 throwLeaf = true
 // A real Worker frame has reached a real React renderer before the terminal leaf throws.
 await runtime.ui.render(); await paint()
 await waitFor(()=>faults.length === 1)
 expect(faults[0]).toEqual({surface:'terminal',component:mode==='above'?'AbovePrompt':'Pane',requestId:mode==='above'?'above-prompt':'panel',element:'surface',module:'surface.ts',phase:'render',reason:'terminal consumer rejected the leaf'})
 expect(rejectedLeaf).toBeGreaterThan(0)
 await waitFor(()=>texts().includes('terminal consumer rejected'))
 expect(texts()).not.toContain('terminal leaf')
 const ink=instances.get(output as never) as unknown as {rootNode:DOMNode}
 const findFault=(node:DOMNode):DOMElement|undefined=>{
  if(node.nodeName==='#text')return undefined
  if(node.nodeName==='ink-text'&&node.childNodes.some(child=>child.nodeName==='#text'&&child.nodeValue.startsWith('owner: Client')))return node
  return node.childNodes.map(findFault).find(Boolean)
 }
 const faultNode=findFault(ink.rootNode)!
 expect(inactive).not.toBeUndefined()
 expect(faultNode.textStyles.color).toBe(inactive)
 expect(faultNode.parentNode!.yogaNode!.getComputedWidth()).toBe(24)
 expect(faultNode.parentNode!.yogaNode!.getComputedHeight()).toBe(3)
 const errorFrames=frames.slice(beforeFaultFrame)
 expect(errorFrames.some(rows=>rows.join('').includes('owner: Client'))).toBe(true)
 // The logical frame between true boundary throw and failed snapshot preserves
 // the Client's existing region with a blank child. This is not a native replay.
 expect(errorFrames.some(rows=>!rows.join('').includes('terminal leaf')&&!rows.join('').includes('owner: Client'))).toBe(true)
 if(scenario==='sibling')expect(texts()).toContain('sibling leaf:state=0')
 const rejected = rejectedLeaf
 throwLeaf = false
 await runtime.ui.render(); await paint()
 expect(texts()).toContain('terminal consumer rejected')
 expect(rejectedLeaf).toBe(rejected)
 const failedWorkers = workerStarts
 const checkFailed = () => {expect(texts()).toContain('terminal consumer rejected');expect(workerStarts).toBe(failedWorkers)}
 if(scenario==='repeat') {
  const before=workerStarts;prop={a:3,b:2};throwLeaf=true;await runtime.ui.render();await paint();await waitFor(()=>faults.length===2);expect(workerStarts).toBe(before+1)
  await runtime.ui.render();await paint();expect(workerStarts).toBe(before+1)
  throwLeaf=false;prop={a:4,b:2};await runtime.ui.render();await paint();await waitFor(()=>texts().includes('terminal leaf'));expect(workerStarts).toBe(before+2)
 } else if(mode !== 'above') {
  if(scenario === 'props' || scenario === 'key-order') prop = scenario==='props'?{a:3,b:2}:{b:2,a:1}
  if(scenario === 'region') { width = 19; region = {columns:99,rows:18} }
  if(scenario === 'columns') global = {...global,columns:161}
  if(scenario === 'rows') global = {...global,rows:41}
  if(scenario === 'conversationColumns') global = {...global,conversationColumns:112}
  await paint(); checkFailed()
  await runtime.ui.render(); await paint()
  if(['props','columns','rows','conversationColumns'].includes(scenario)) {
    await waitFor(()=>texts().includes('terminal leaf'))
    expect(workerStarts).toBe(failedWorkers+1)
    expect(texts()).toContain('state=0')
    expect(faults).toHaveLength(1)
  } else checkFailed()
 }
 console.log(JSON.stringify({mode,scenario,workerStarts,logicalFrames:frames.length,errorFrames,ownFault:faults[0],terminalThrows:rejectedLeaf,failedText:texts(),status:'passed'}))
 }
} finally {inkRoot?.unmount();await runtime.dispose();await rm(root,{recursive:true,force:true})}
