import {afterEach, beforeEach, expect, test} from 'bun:test'
import React, {useLayoutEffect, useSyncExternalStore} from 'react'
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises'
import {readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Readable, Writable} from 'node:stream'
import ts from 'typescript'
import {ThemeProvider, render} from '../ink.js'
import instances from '../ink/instances.js'
import type {DOMElement, DOMNode} from '../ink/dom.js'
import {getFocusManager} from '../ink/focus.js'
import useStdin from '../ink/hooks/use-stdin.js'
import {createModsRuntime, type ModDiagnostic} from '../services/mods/runtime.js'
import {resetSettingsCache} from '../utils/settings/settingsCache.js'
import {ModsPane} from './ModsPane.js'

const envKeys = ['HOME','CLAUDE_CONFIG_DIR','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_STATE_HOME',
  'ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR','CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR']
let saved: (string | undefined)[], config: string
beforeEach(async () => {
  saved = envKeys.map(key => process.env[key]); config = await realpath(await mkdtemp(join(tmpdir(), 'mods-af-config-')))
  for (const key of envKeys) delete process.env[key]
  process.env.HOME = config; process.env.CLAUDE_CONFIG_DIR = join(config,'config')
  process.env.XDG_CONFIG_HOME = join(config,'xdg-config'); process.env.XDG_CACHE_HOME = join(config,'xdg-cache')
  process.env.XDG_STATE_HOME = join(config,'xdg-state'); process.env.ANTHROPIC_API_KEY = 'sk-test-placeholder'
  resetSettingsCache()
})
afterEach(async () => {
  resetSettingsCache(); envKeys.forEach((key,i) => {if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]})
  await rm(config,{recursive:true,force:true})
})
class Input extends Readable {
  isTTY = true
  _read() {}
  setRawMode() {return this}
  ref() {return this}
  unref() {return this}
}
class Output extends Writable {
  columns = 160; rows = 40; isTTY = true
  _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void) {done()}
}
async function until(predicate: () => boolean, evidence?: () => unknown) {
  const end = Date.now()+1500
  while (!predicate() && Date.now()<end) await new Promise(resolve => setImmediate(resolve))
  if (!predicate() && evidence) console.error(JSON.stringify(evidence()))
  expect(predicate()).toBe(true)
}
function contents(node: DOMNode): string {return node.nodeName === '#text' ? node.nodeValue : node.childNodes.map(contents).join('')}
function find(root: DOMElement, label: string): DOMElement | undefined {
  if (root.nodeName === 'ink-text' && contents(root) === label) return root
  for (const child of root.childNodes) if (child.nodeName !== '#text') {const value=find(child,label); if (value) return value}
}
function replFocus(scope: Record<string, unknown>): React.ComponentProps<typeof ModsPane>['onFocus'] {
  const source=readFileSync(new URL('../screens/REPL.tsx', import.meta.url),'utf8')
  const file=ts.createSourceFile('REPL.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
  const renderers: ts.ArrowFunction[]=[]
  const visit=(node: ts.Node) => {if (ts.isVariableDeclaration(node) && node.name.getText(file)==='renderModPane' && node.initializer && ts.isArrowFunction(node.initializer)) renderers.push(node.initializer); ts.forEachChild(node,visit)}
  visit(file); expect(renderers).toHaveLength(1)
  const callbacks: ts.Expression[]=[]
  const search=(node: ts.Node) => {if (ts.isJsxAttribute(node) && node.name.getText(file)==='onFocus' && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) callbacks.push(node.initializer.expression); ts.forEachChild(node,search)}
  search(renderers[0]!); expect(callbacks).toHaveLength(1)
  const code=ts.transpileModule('const callback=('+callbacks[0]!.getText(file)+');', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText
  return new Function('scope','with(scope){'+code+';return callback;}')(scope)
}
type Kind='Button'|'Input'|'Select'
type Policy='accept'|'deny'|'withhold'|'rewrite'|'unknown'
async function mount(kind: Kind, policy: Policy, hidden = false, decorate = false) {
  const directory=await realpath(await mkdtemp(join(tmpdir(),'mods-af-author-'))),entry=join(directory,'register.ts')
  const action=(key: string) => `onPress:event=>{const action={key:${JSON.stringify(key)},event};actions.push(action);$.ui.status(JSON.stringify({kind:'action',action}))}`
  const control=(key: string) => kind==='Button'
    ? `Button({key:'${key}',label:'${key}',autoFocus:true,${action(key)}})`
    : kind==='Select' ? `Select({key:'${key}',label:'${key}',value:'one',options:[{value:'one',label:'One'}],autoFocus:true,onSelect:(value,event)=>{actions.push({key:'${key}',value,event})}})`
    : `Input({key:'${key}',label:'${key}',placeholder:'${key}-empty',autoFocus:true,onInput:(value,event)=>{changes.push({key:'${key}',value,event})},onSubmit:(value,event)=>{actions.push({key:'${key}',value,event})}})`
  const behavior=policy==='deny' ? "return {deny:'held'}" : policy==='withhold' ? 'return {}' : policy==='rewrite' ? "return next({element:'second'})" : policy==='unknown' ? "return next({element:'missing'})" : 'return next(e)'
  await writeFile(entry,`const actions=[],changes=[];export function register(on){
    on('session.start',async($,e,next)=>{await $.ui.open({id:'af',focus:true,rows:6});return next(e)});
    on('ui.render',{component:'Pane',requestId:'af'},($,e)=>{const {Box,Text,Button,Input,Select}=$.ui.resolve(e);return Box({flexDirection:'column',children:[Text({children:'AF-SURFACE'}),${hidden?"Box({display:'none',children:["+control('first')+"]})":control('first')},${control('second')}]})});
    on('ui.focus',async($,e,next)=>{$.ui.status(JSON.stringify({kind:'focus',event:e,caller:next.origin}));const result=await(async()=>{${behavior}})();$.ui.status(JSON.stringify({kind:'settled',result}));return result});
    on('command.run',{command:'checkpoint'},()=>({text:JSON.stringify({actions,changes})}));
  }`)
  const receipts: {kind:string;event?:unknown;caller?:unknown;result?:unknown}[]=[],diagnostics: ModDiagnostic[]=[],errors: unknown[]=[]
  const presentation={columns:160,rows:40,isFullscreen:false,composerEmpty:true,hasDialog:false,keyboardOwned:false}
  const runtime=createModsRuntime({onDiagnostic:e=>diagnostics.push(e),services:{uiPresentation:()=>presentation,uiStatus:(_plugin,text)=>{if(text) receipts.push(JSON.parse(text))}}})
  const stdin=new Input(),stdout=new Output();let completed=0; let committedRevision=-1; let committedDrawing: number | undefined; let reorderInput: (() => void) | undefined
  const onFocus=replFocus({modsSession:{runtime},modUiPresentationRef:{current:presentation}})
  function Observer() {
    const {internal_eventEmitter}=useStdin()
    useLayoutEffect(()=>{const observe=()=>{queueMicrotask(()=>{completed++})};reorderInput=()=>{internal_eventEmitter.removeListener('input',observe);internal_eventEmitter.prependListener('input',observe)};reorderInput();return()=>{internal_eventEmitter.removeListener('input',observe)}},[internal_eventEmitter])
    return null
  }
  function Host() {
    const panes=useSyncExternalStore(runtime.ui.subscribe,runtime.ui.getSnapshot),pane=panes[0]
    useLayoutEffect(()=>{committedRevision=pane?.revision??-1;committedDrawing=pane?.drawing})
    return <><Observer />{pane && <ModsPane pane={pane} onFocus={onFocus}
      onInteract={(pane,drawing,callback,kind,element,value)=>runtime.ui.interact(pane.id,drawing,callback,kind,element,value)}
      onClose={pane=>runtime.ui.close(pane.owner,pane.id,{kind:'person'})}
      onScroll={(pane,by)=>runtime.ui.scroll(pane.owner,{requestId:pane.id,by,origin:{kind:'person'}})}
      onReportMetrics={(pane,metrics)=>runtime.ui.reportMetrics(pane.id,metrics)} onError={e=>errors.push(e)} />}</>
  }
  let instance: Awaited<ReturnType<typeof render>> | undefined
  try {
    await runtime.bind({cwd:directory,surface:'terminal',isInteractive:true,sessionId:'af-test'})
    instance=await render(<ThemeProvider><Host /></ThemeProvider>,{stdin:stdin as never,stdout:stdout as never,exitOnCtrlC:false,patchConsole:false})
    const declarations=[{name:'af-owner',storageId:'af-owner@test',pluginRoot:directory,entrypoints:[entry]}]
    if(decorate) {
      const decorator=join(directory,'decorator.ts')
      await writeFile(decorator,`export function register(on){on('ui.render',{component:'Pane',requestId:'af'},async($,e,next)=>{const body=await next(e);const {Box,Button}=$.ui.resolve(e);return Box({flexDirection:'column',children:[Button({key:'first',label:'Duplicate',onPress:event=>{$.ui.status(JSON.stringify({kind:'decoratorAction',event}))}}),body]})})}`)
      declarations.unshift({name:'af-decorator',storageId:'af-decorator@test',pluginRoot:directory,entrypoints:[decorator]})
    }
    await runtime.reconcile(declarations)
    const dom=()=>(instances.get(stdout as never) as unknown as {rootNode:DOMElement}).rootNode
    await until(()=>find(dom(),'AF-SURFACE')!==undefined,()=>({kind,policy,diagnostics,errors:errors.map(String),receipts,panes:runtime.ui.getSnapshot().map(p=>({id:p.id,focused:p.focused,element:p.focusedElement,drawing:p.drawing,revision:p.revision,treeType:(p.tree as {type?:string})?.type})),text:contents(dom()).slice(0,600)}))
    const element=(key:string) => {
      const label=kind==='Button'?(key==='duplicate'?'[ Duplicate ]':'[ '+key+' ]'):key+': '
      for(let node=find(dom(),label);node;node=node.parentNode) if(typeof node.attributes.tabIndex==='number') return node
    }
    const raw=async (value:string,count:number) => {
      await runtime.settle(); await until(()=>{const pane=runtime.ui.getSnapshot()[0];return pane?.revision===committedRevision && pane?.drawing===committedDrawing});
      const before=completed; reorderInput!(); stdin.push(value); await until(()=>completed===before+count); await runtime.settle();
      if(decorate) await until(()=>receipts.some(r=>r.kind==='decoratorAction'),()=>({receipts,diagnostics,errors:errors.map(String),focus:getFocusManager(dom()).activeElement?contents(getFocusManager(dom()).activeElement!):null,text:contents(dom())}))
      const snapshot=runtime.capture()
      try {const result=await snapshot.dispatch('command.run',{command:'checkpoint',args:'',origin:{kind:'composer'},presentation:{columns:160,isFullscreen:false}},async()=>({})) as {text:string};return JSON.parse(result.text)}
      finally {snapshot.release()}
    }
    const dispose=async()=>{instance?.unmount();await runtime.dispose();await rm(directory,{recursive:true,force:true})}
    return {runtime,receipts,diagnostics,errors,dom,element,raw,dispose}
  } catch(error) {instance?.unmount();await runtime.dispose();await rm(directory,{recursive:true,force:true});throw error}
}
for(const kind of ['Button','Input','Select'] as const) test('automatic '+kind+' negotiates from engine before landing the first drawn control',async()=>{
  const h=await mount(kind,'accept')
  try {
    await until(()=>h.receipts.some(r=>r.kind==='settled') && h.runtime.ui.getSnapshot()[0]?.focusedElement==='first')
    expect(h.receipts.filter(r=>r.kind==='focus')).toEqual([{kind:'focus',event:{component:'Pane',requestId:'af',plugin:'af-owner',element:'first',origin:{kind:'plugin',name:'af-owner'}},caller:{plugin:'engine',tier:'core'}}])
    await until(()=>getFocusManager(h.dom()).activeElement===h.element('first'))
    const state=await h.raw(kind==='Input'?'u\r':'\r',kind==='Input'?2:1)
    expect(state.actions).toHaveLength(1); expect(state.actions[0]).toMatchObject({key:'first',event:{plugin:'af-owner',element:'first',component:'Pane',requestId:'af'}})
    expect(state.changes).toMatchObject(kind==='Input'?[{key:'first',value:'u'}]:[])
    expect(h.diagnostics).toEqual([]);expect(h.errors).toEqual([])
  } finally {await h.dispose()}
})
for(const policy of ['deny','withhold','rewrite','unknown'] as const) test('automatic focus respects '+policy+' without granting an unapproved native control',async()=>{
  const h=await mount('Button',policy)
  try {
    await until(()=>h.receipts.some(r=>r.kind==='settled'))
    const expected=policy==='rewrite'?'second':undefined
    expect(h.runtime.ui.getSnapshot()[0]?.focusedElement).toBe(expected)
    if(expected) await until(()=>getFocusManager(h.dom()).activeElement===h.element(expected))
    else {expect(getFocusManager(h.dom()).activeElement===h.element('first')).toBe(false);expect(getFocusManager(h.dom()).activeElement===h.element('second')).toBe(false)}
    const state=await h.raw('\r',1);expect(state.actions).toHaveLength(expected?1:0)
    if(expected) expect(state.actions[0].key).toBe(expected)
    expect(h.receipts.filter(r=>r.kind==='focus')).toHaveLength(1);expect(h.errors).toEqual([])
  } finally {await h.dispose()}
})
test('automatic focus preserves official registration order for a hidden control',async()=>{
  const h=await mount('Button','accept',true)
  try {
    // Official 2.1.292 native af-hidden: display:none keeps the first focus registration.
    await until(()=>h.runtime.ui.getSnapshot()[0]?.focusedElement==='first')
    expect(h.receipts.filter(r=>r.kind==='focus')).toHaveLength(1)
    await until(()=>getFocusManager(h.dom()).activeElement===h.element('first'))
    const state=await h.raw('\r',1);expect(state.actions).toHaveLength(1);expect(state.actions[0].key).toBe('first')
  }
  finally {await h.dispose()}
})


test('automatic focus preserves official duplicate-key event and terminal slot behavior',async()=>{
  const h=await mount('Button','accept',false,true)
  try {
    await until(()=>h.runtime.ui.getSnapshot()[0]?.focusedElement==='first')
    await until(()=>getFocusManager(h.dom()).activeElement===h.element('duplicate'))
    const state=await h.raw('\r',1)
    expect(state.actions).toHaveLength(0)
    expect(h.receipts.filter(r=>r.kind==='decoratorAction')).toEqual([{kind:'decoratorAction',event:{plugin:'af-decorator',element:'first',component:'Pane',requestId:'af',surface:'terminal'}}])
    expect(h.receipts.filter(r=>r.kind==='focus')).toHaveLength(1)
    expect(h.diagnostics).toEqual([]);expect(h.errors).toEqual([])
  } finally {await h.dispose()}
})


test('a same-read arrow then Enter activates only the negotiated landing',async()=>{
  const h=await mount('Button','accept',true)
  try {
    await until(()=>h.runtime.ui.getSnapshot()[0]?.focusedElement==='first')
    await until(()=>getFocusManager(h.dom()).activeElement===h.element('first'))
    const state=await h.raw('\u001b[B\r',2)
    expect(state.actions).toHaveLength(1)
    expect(state.actions[0].key).toBe('second')
    expect(h.receipts.filter(r=>r.kind==='focus')).toHaveLength(2)
    expect(h.errors).toEqual([]);expect(h.diagnostics).toEqual([])
  } finally {await h.dispose()}
})
