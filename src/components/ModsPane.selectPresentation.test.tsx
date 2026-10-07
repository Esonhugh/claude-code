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
import {getTheme} from '../utils/theme.js'
import {resetSettingsCache} from '../utils/settings/settingsCache.js'
import type {ModUiPane} from '../services/mods/ui.js'
import {ModsPane, validateModRenderTree} from './ModsPane.js'

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
const options=Array.from({length:12},(_,i)=>({value:'v'+i,label:i===0?'Zero':i===1?'Beta':i===2?'Beta 2':'Item '+i}))
async function mount(initial:Record<string,unknown>={},respond:(value?:string)=>Promise<unknown>=async value=>({element:'pick',value}),isWorking=false){
 const stdin=new Input(),stdout=new Output(),owner={};let completed=0,reorder:()=>void=()=>{};let props={value:'v0',options,...initial};const events:{kind:string;value?:string}[]=[]
 let pane:ModUiPane={id:'select',plugin:'fixture',owner,title:'Select',visible:true,shown:true,placement:'dock',focused:true,focusedElement:'pick',closeOnEscape:true,holdToasts:false,scrollOffset:0,bodyRows:34,bodyColumns:71,revision:0,contentRows:1,drawing:1}
 function Observer(){const {internal_eventEmitter}=useStdin();useLayoutEffect(()=>{const observe=()=>queueMicrotask(()=>{completed++});reorder=()=>{internal_eventEmitter.removeListener('input',observe);internal_eventEmitter.prependListener('input',observe)};reorder();return()=>{internal_eventEmitter.removeListener('input',observe)}},[internal_eventEmitter]);return null}
 const draw=()=> <><Observer/><ModsPane isWorking={isWorking} pane={{...pane,tree:{type:'Box',props:{flexDirection:'column'},children:[{type:'Select',props:{key:'pick',label:'Rich',...props},press:{plugin:'fixture',handle:1}},{type:'Button',props:{key:'tail',label:'Tail',hotkey:'b'},press:{plugin:'fixture',handle:2}}]}}}
  onFocus={async(_pane,element)=>({focused:element!==undefined,element,revision:pane.revision})} onClose={async()=>({})} onScroll={async()=>({})}
  onInteract={async(_pane,_drawing,_callback,kind,_element,value)=>{events.push({kind,value});return respond(value)}}/></>
 const instance=await render(draw(),{stdin:stdin as never,stdout:stdout as never,exitOnCtrlC:false,patchConsole:false})
 const dom=()=>(instances.get(stdout as never) as unknown as {rootNode:DOMElement}).rootNode
 await until(()=>texts(dom()).some(node=>contents(node).includes('Rich:')))
 const find=(text:string)=>texts(dom()).find(node=>contents(node)===text)
 const raw=async(value:string,count=1)=>{const before=completed;reorder();stdin.push(value);await until(()=>completed===before+count)}
 return {dom,find,raw,events,dispose:()=>instance.unmount(),redraw:async(next:Record<string,unknown>)=>{props={...props,...next};pane={...pane,drawing:pane.drawing!+1,revision:pane.revision+1};instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>);await until(()=>texts(dom()).some(node=>contents(node).includes('Rich:')))}}
}
test('Select opens on focus with official label, eight rows and remaining count',async()=>{
 const h=await mount()
 try{await until(()=>h.find('Rich: ')?.textStyles?.bold===true);expect(h.find(' ▴')).toBeDefined();expect(h.find('  Zero')?.textStyles?.inverse).toBe(true);expect(h.find('Zero')?.textStyles?.inverse).not.toBe(true);expect(h.find('  Item 7')).toBeDefined();expect(h.find('  Item 8')).toBeUndefined();expect(String(h.find('  … 4 more')?.textStyles?.color)).toBe(getTheme('dark').inactive)}finally{h.dispose()}
})
test('Select arrows move highlight without changing the picked header; Enter picks and closes',async()=>{
 const h=await mount()
 try{await h.raw('\u001b[B');await until(()=>h.find('  Beta')?.textStyles?.inverse===true);expect(h.find('Zero')).toBeDefined();expect(h.events).toEqual([]);await h.raw('\r');await until(()=>h.events.length===1 && h.find(' ▾')!==undefined);expect(h.find('Beta')?.textStyles?.inverse).toBe(true);expect(h.events).toEqual([{kind:'select',value:'v1'}]);expect(h.find('  Beta')).toBeUndefined()}finally{h.dispose()}
})
test('Select closed arrows or Enter open without moving or submitting',async()=>{
 const h=await mount()
 try{await h.raw('\u0003');await until(()=>h.find(' ▾')!==undefined);await h.raw('\u001b[B');await until(()=>h.find('  Zero')?.textStyles?.inverse===true);expect(h.events).toEqual([]);await h.raw('\r');await until(()=>h.events.length===1);await h.raw('\r');await until(()=>h.find(' ▴')!==undefined);expect(h.events).toEqual([{kind:'select',value:'v0'}])}finally{h.dispose()}
})
test('Select cycles case-insensitive prefix labels and consumes Space without selecting or Button hotkeys',async()=>{
 const h=await mount()
 try{await h.raw('b');await until(()=>h.find('  Beta')?.textStyles?.inverse===true);await h.raw('B');await until(()=>h.find('  Beta 2')?.textStyles?.inverse===true);await h.raw('b');await until(()=>h.find('  Beta')?.textStyles?.inverse===true);await h.raw(' ');expect(h.events).toEqual([]);await h.raw('\r');await until(()=>h.events.length===1);expect(h.events).toEqual([{kind:'select',value:'v1'}])}finally{h.dispose()}
})
test('Select scroll window follows highlight and clamps when options shorten',async()=>{
 const h=await mount()
 try{await h.raw('\u001b[B'.repeat(10),10);await until(()=>h.find('  Item 10')?.textStyles?.inverse===true);expect(h.find('  Item 3')).toBeDefined();expect(h.find('  Beta 2')).toBeUndefined();expect(h.find('  … 1 more')).toBeDefined();await h.redraw({options:options.slice(0,2)});await until(()=>h.find('  Beta')?.textStyles?.inverse===true);await h.raw('\r');await until(()=>h.events.length===1);expect(h.events).toEqual([{kind:'select',value:'v1'}])}finally{h.dispose()}
})
for(const receipt of [undefined,{deny:'held'}])test('Select preserves an optimistic pick when no successful receipt arrives: '+JSON.stringify(receipt),async()=>{
 const h=await mount({},async()=>receipt)
 try{await h.raw('\u001b[B\r',2);await until(()=>h.events.length===1 && h.find('Beta')!==undefined);expect(h.find(' ▾')).toBeDefined();expect(h.events).toEqual([{kind:'select',value:'v1'}])}finally{h.dispose()}
})
test('Select applies rewritten receipt value but does not overwrite a newer pick',async()=>{
 let release!:(value:unknown)=>void;const receipt=new Promise(resolve=>{release=resolve});let call=0
 const h=await mount({},async value=>++call===1?receipt:{element:'pick',value})
 try{await h.raw('\u001b[B\r',2);await until(()=>h.events.length===1);release({element:'pick',value:'v2'});await until(()=>h.find('Beta 2')!==undefined);await h.raw('\r\u001b[B\r',3);await until(()=>h.events.length===2);expect(h.events[1]).toEqual({kind:'select',value:'v2'})}finally{release(undefined);h.dispose()}
})
test('Select does not let a late receipt overwrite a newer optimistic choice',async()=>{
 let release!:(value:unknown)=>void;const receipt=new Promise(resolve=>{release=resolve});let call=0
 const h=await mount({},async value=>++call===1?receipt:{element:'pick',value})
 try{await h.raw('\u001b[B\r',2);await until(()=>h.events.length===1);await h.raw('\r\u001b[B\r',3);await until(()=>h.events.length===2);release({element:'pick',value:'v9'});await new Promise(resolve=>setImmediate(resolve));expect(h.find('Item 9')).toBeUndefined();await until(()=>h.find('Beta 2')!==undefined);expect(h.events).toEqual([{kind:'select',value:'v1'},{kind:'select',value:'v2'}])}finally{release(undefined);h.dispose()}
})
test('Select equal drawn values preserve picks and a new value replaces them',async()=>{
 const h=await mount()
 try{await h.raw('\u001b[B\r',2);await until(()=>h.events.length===1 && h.find('Beta')!==undefined);await h.redraw({value:'v0'});expect(h.find('Beta')).toBeDefined();await h.redraw({value:'v2'});await until(()=>h.find('Beta 2')!==undefined);expect(h.events).toEqual([{kind:'select',value:'v1'}])}finally{h.dispose()}
})
test('Select accepts an unknown drawn value and shows none while highlighting the first option',async()=>{
 const h=await mount({value:'gone'})
 try{await until(()=>h.find('none')?.textStyles?.color===getTheme('dark').inactive);expect(h.find('  Zero')?.textStyles?.inverse).toBe(true);await h.raw('\r');await until(()=>h.events.length===1);expect(h.events).toEqual([{kind:'select',value:'v0'}])}finally{h.dispose()}
})
test('Select keeps the official host rejection of duplicate values',()=>{
 expect(()=>validateModRenderTree({type:'Select',props:{key:'pick',options:[{value:'x',label:'A'},{value:'x',label:'B'}]},press:{plugin:'fixture',handle:1}})).toThrow(/unique/i)
})
test('Select Ctrl+C while working leaves the open list for cancellation ownership',async()=>{
 const h=await mount({},undefined,true)
 try{await h.raw('\u0003');expect(h.find(' ▴')).toBeDefined();expect(h.find('Rich: ')?.textStyles?.bold).toBe(true);expect(h.events).toEqual([])}finally{h.dispose()}
})
test('Select second Ctrl+C releases the ring to the pane body and redraw keeps it released',async()=>{
 const h=await mount()
 try{await h.raw('\u0003\u0003',2);await until(()=>h.find('Rich: ')?.textStyles?.bold!==true);await h.redraw({value:'v0'});expect(h.find('Rich: ')?.textStyles?.bold).not.toBe(true);expect(h.find(' ▴')).toBeUndefined();expect(h.events).toEqual([])}finally{h.dispose()}
})
