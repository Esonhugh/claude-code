import { expect,test } from 'bun:test'
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createModsRuntime } from './runtime.js'
for(const event of ['pointer','key','tick','held']) test(`actual runtime ${event} returned rejection publishes owning ui.fault while siblings/hooks live`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'mods-returned-runtime-'))
 const pluginRoot=join(root,'owner');await mkdir(pluginRoot)
 const entry=join(pluginRoot,'register.ts')
 await writeFile(entry,`export function register(on) {
  on('session.start',async($,e,next)=>{await $.ui.open({id:'panel'});return next(e)});
  on('ui.render',($,e)=>{const {Box,Client}=$.ui.resolve(e);return Box({children:[Client({key:'first',module:'./surface.ts'}),Client({key:'sibling',module:'./surface.ts'})]})});
  on('ui.fault',async($,e,next)=>{await $.ui.status(JSON.stringify(e));return next(e)});
  on('tool.call',{tool:'Probe'},()=>({result:'hooks alive'}));
 }`)
 await writeFile(join(pluginRoot,'surface.ts'),`let initialized=false;let reject;
 export default function Surface(_,s) {
  const action=()=>new Promise((_ok,bad)=>{reject=bad});
  if(!initialized){initialized=true;s.onPointer(action);s.onKey(e=>{if(e.key==='release'){reject?.(Error('runtime rejection'));return}return action()});if('${event}'==='tick')s.every(1,action)}
  return '${event}'==='held'?s.elements.Button({key:'go',label:'Go',onPress:action}):s.elements.Text({children:'ready'});
 }`)
 const observed:any[]=[];const heard=Promise.withResolvers<any>()
 const runtime=createModsRuntime({services:{
  uiPresentation:()=>({columns:160,rows:40,isFullscreen:true,composerEmpty:true,hasDialog:false,keyboardOwned:false}),
  uiStatus:(_name,text)=>{if(text!==undefined){const value=JSON.parse(text);observed.push(value);heard.resolve(value)}},
 }})
 let first:any,sibling:any
 try {
  await runtime.bind({cwd:root,surface:'terminal',isInteractive:true,sessionId:'returned'})
  await runtime.reconcile([{name:'owner',storageId:'owner@test',pluginRoot,entrypoints:[entry]}])
  const pane=runtime.ui.getSnapshot()[0]!
  const nodes=(pane.tree as any).children
  let tree:any
  first=pane.clients!.mount({...pane,clock:'manual'},nodes[0],output=>{tree=output})
  sibling=pane.clients!.mount({...pane,clock:'manual'},nodes[1],()=>{})
  await first.ready;await sibling.ready
  if(event==='tick') await first.advance(1)
  else if(event==='held') await first.press(tree.press,'press','go')
  else await first[event]({key:'start',type:'down'})
  expect(observed).toEqual([])
  await first.key({key:'release'}).catch(()=>{})
  const timeout=setTimeout(()=>heard.reject(Error('returned rejection did not publish ui.fault')),500)
  let fault:any
  try {fault=await heard.promise} finally {clearTimeout(timeout)}
  expect(fault).toEqual({surface:'terminal',component:'Pane',requestId:'panel',element:'first',module:'surface.ts',phase:'run',reason:'a promise it returned was rejected: runtime rejection'})
  expect(observed).toEqual([fault])
  await sibling.key({key:'alive'})
  expect(await runtime.dispatch('tool.call',{tool:'Probe'},async()=>({result:'core'}))).toEqual({result:'hooks alive'})
 } finally {await first?.dispose();await sibling?.dispose();await runtime.dispose();await rm(root,{recursive:true,force:true})}
})
