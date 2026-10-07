import {afterEach, beforeEach, expect, test} from 'bun:test'
import React, {useLayoutEffect} from 'react'
import chalk from 'chalk'
import {mkdtemp, realpath, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Readable, Writable} from 'node:stream'
import {ThemeProvider, render} from '../ink.js'
import instances from '../ink/instances.js'
import type {DOMElement, DOMNode} from '../ink/dom.js'
import useStdin from '../ink/hooks/use-stdin.js'
import {resetSettingsCache} from '../utils/settings/settingsCache.js'
import type {ModUiPane} from '../services/mods/ui.js'
import {ModsPane} from './ModsPane.js'

const envKeys=['HOME','CLAUDE_CONFIG_DIR','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_STATE_HOME',
 'ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR','CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR']
let saved:(string|undefined)[],config:string, colorLevel:number
beforeEach(async()=>{
 colorLevel=chalk.level;chalk.level=3; saved=envKeys.map(key=>process.env[key]);config=await realpath(await mkdtemp(join(tmpdir(),'mods-input-config-')))
 for(const key of envKeys)delete process.env[key]
 process.env.HOME=config;process.env.CLAUDE_CONFIG_DIR=join(config,'config');process.env.XDG_CONFIG_HOME=join(config,'xdg-config')
 process.env.XDG_CACHE_HOME=join(config,'xdg-cache');process.env.XDG_STATE_HOME=join(config,'xdg-state');process.env.ANTHROPIC_API_KEY='sk-test-placeholder';resetSettingsCache()
})
afterEach(async()=>{chalk.level=colorLevel as typeof chalk.level;resetSettingsCache();envKeys.forEach((key,i)=>{if(saved[i]===undefined)delete process.env[key];else process.env[key]=saved[i]});await rm(config,{recursive:true,force:true})})
class Input extends Readable {isTTY=true;_read(){};setRawMode(){return this};ref(){return this};unref(){return this}}
class Output extends Writable {columns=160;rows=40;isTTY=true;_write(_chunk:Buffer,_encoding:BufferEncoding,done:()=>void){done()}}
async function until(check:()=>boolean){const deadline=Date.now()+1500;while(!check()&&Date.now()<deadline)await new Promise(resolve=>setImmediate(resolve));expect(check()).toBe(true)}
function contents(node:DOMNode):string{return node.nodeName==='#text'?node.nodeValue:node.childNodes.map(contents).join('')}
function texts(node:DOMNode):DOMElement[]{return node.nodeName==='#text'?[]:[...(['ink-text','ink-virtual-text'].includes(node.nodeName)?[node]:[]),...node.childNodes.flatMap(texts)]}
async function mount(props:Record<string,unknown>={},respond:(kind:string,value?:string)=>Promise<unknown>=async(_kind,value)=>({element:'reply',value})){
 const stdin=new Input(),stdout=new Output(),owner={};let completed=0,reorder:()=>void=()=>{};const events:{kind:string;value?:string}[]=[]
 let pane:ModUiPane={id:'input',plugin:'fixture',owner,title:'Input',visible:true,shown:true,placement:'dock',focused:true,focusedElement:'reply',closeOnEscape:true,holdToasts:false,scrollOffset:0,bodyRows:34,bodyColumns:71,revision:0,contentRows:1,drawing:1}
 function Observer(){const {internal_eventEmitter}=useStdin();useLayoutEffect(()=>{const observe=()=>queueMicrotask(()=>{completed++});reorder=()=>{internal_eventEmitter.removeListener('input',observe);internal_eventEmitter.prependListener('input',observe)};reorder();return()=>{internal_eventEmitter.removeListener('input',observe)}},[internal_eventEmitter]);return null}
 const draw=()=> <><Observer/><ModsPane pane={{...pane,tree:{type:'Input',props:{key:'reply',label:'Reply',placeholder:'Empty',...props},press:{plugin:'fixture',handle:1}}}}
  onFocus={async(_pane,element)=>({focused:true,element,revision:pane.revision})} onClose={async()=>({})} onScroll={async()=>({})}
  onInteract={async(_pane,_drawing,_callback,kind,_element,value)=>{events.push({kind,value});return respond(kind,value)}}/></>
 const instance=await render(draw(),{stdin:stdin as never,stdout:stdout as never,exitOnCtrlC:false,patchConsole:false})
 const dom=()=>(instances.get(stdout as never) as unknown as {rootNode:DOMElement}).rootNode
 await until(()=>texts(dom()).some(node=>contents(node)==='Reply: '))
 const find=(text:string)=>texts(dom()).find(node=>contents(node)===text)
 const raw=async(value:string,count=1)=>{const before=completed;reorder();stdin.push(value);await until(()=>completed===before+count)}
 return {dom,find,raw,events,dispose:()=>instance.unmount(),redraw:async(next:Record<string,unknown>)=>{props=next;pane={...pane,drawing:pane.drawing!+1,revision:pane.revision+1};instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>);await until(()=>texts(dom()).some(node=>contents(node)==='Reply: '))}}
}
test('focused Input paints the official label, single placeholder caret and submit hint',async()=>{
 const h=await mount()
 try{await until(()=>h.find('Reply: ')?.textStyles?.bold===true);expect(h.find('E')?.textStyles?.inverse).toBe(true);expect(h.find('mpty')?.textStyles?.dim).toBe(true);expect(h.find(' ⏎ submit')).toBeDefined();expect(h.find('Empty')?.textStyles?.inverse).not.toBe(true)}finally{h.dispose()}
})
test('Input caret moves and paints a whole grapheme without changing the value',async()=>{
 const h=await mount({value:'A👨‍👩‍👧‍👦B'})
 try{await until(()=>h.find(' ')?.textStyles?.inverse===true);await h.raw('\u001b[D');await until(()=>h.find('B')?.textStyles?.inverse===true);await h.raw('\u001b[D');await until(()=>h.find('👨‍👩‍👧‍👦')?.textStyles?.inverse===true);expect(h.events).toEqual([])}finally{h.dispose()}
})
test('successful Input submit clears only after its receipt and emits no synthetic change',async()=>{
 let release!:(value:unknown)=>void;const receipt=new Promise(resolve=>{release=resolve})
 const h=await mount({value:'ready'},async(kind,value)=>kind==='input.submit'?receipt:{element:'reply',value})
 try{await h.raw('\r');await until(()=>h.events.length===1);expect(contents(h.dom())).toContain('ready');release({element:'reply',value:'ready'});await until(()=>contents(h.dom()).includes('Empty'));expect(h.events).toEqual([{kind:'input.submit',value:'ready'}])}finally{release(undefined);h.dispose()}
})
test('Input does not clear newer typing or double-submit while the receipt is pending',async()=>{
 let release!:(value:unknown)=>void;const receipt=new Promise(resolve=>{release=resolve})
 const h=await mount({value:'ready'},async(kind,value)=>kind==='input.submit'?receipt:{element:'reply',value})
 try{await h.raw('\r\rX',3);await until(()=>h.events.some(e=>e.kind==='input.submit'));release({element:'reply',value:'ready'});await until(()=>h.events.some(e=>e.kind==='input.change'));expect(h.events).toEqual([{kind:'input.submit',value:'ready'},{kind:'input.change',value:'readyX'}]);expect(contents(h.dom())).toContain('readyX')}finally{release(undefined);h.dispose()}
})
for(const result of [undefined,null,{},{element:'reply'},{deny:'held'}])test('Input keeps text when submit is not delivered: '+JSON.stringify(result),async()=>{
 const h=await mount({value:'ready'},async()=>result)
 try{await h.raw('\r');await until(()=>h.events.length===1);expect(contents(h.dom())).toContain('ready');expect(contents(h.dom())).not.toContain('Empty')}finally{h.dispose()}
})
test('Input preserves edited text across equal drawn values and honors a changed value',async()=>{
 const h=await mount({value:'seed'})
 try{await h.raw('X');await until(()=>h.events.length===1 && contents(h.dom()).includes('seedX'));await h.redraw({value:'seed'});expect(contents(h.dom())).toContain('seedX');await h.redraw({value:'replacement'});await until(()=>contents(h.dom()).includes('replacement'));expect(h.events).toEqual([{kind:'input.change',value:'seedX'}])}finally{h.dispose()}
})
