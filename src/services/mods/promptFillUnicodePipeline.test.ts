import {afterEach,beforeEach,expect,test} from 'bun:test'
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createModsRuntime} from './runtime.js'
import {fillPromptBox,type PromptBox,type PromptFillInput} from './promptAdapter.js'
import type {PromptDecoration} from './promptEdit.js'

let root:string
const runtimes:ReturnType<typeof createModsRuntime>[]=[]
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'owned-fill-unicode-'))})
afterEach(async()=>{await Promise.all(runtimes.splice(0).map(r=>r.dispose()));await rm(root,{recursive:true,force:true})})
const raw='ORIGINAL\u200B'
const rewritten='A\u200B😀\r\nB\uD800C'
const cleaned='A😀\nB�C'
const runs:PromptDecoration[]=[{start:2,end:4,bold:true},{start:1,end:2,italic:true},{start:4,end:6,underline:true},{start:7,end:8,strikethrough:true}]
const mapped:PromptDecoration[]=[{start:1,end:3,bold:true},{start:1,end:1,italic:true},{start:3,end:4,underline:true},{start:5,end:6,strikethrough:true}]
async function plugin(name:string,body:string){const pluginRoot=join(root,name);await mkdir(pluginRoot);const entry=join(pluginRoot,'register.ts');await writeFile(entry,`export function register(on){${body}}`);return{name,storageId:name+'@owned',pluginRoot,entrypoints:[entry]}}
async function setup(policyBody:string){
 const caller=await plugin('fill-caller',`on('tool.call',async($,e)=>{await $.prompt.read();return {result:await $.prompt.fill({text:e.text,mode:e.mode,decorations:e.decorations})}});`)
 const policy=await plugin('fill-policy',policyBody)
 const observed:(Pick<PromptFillInput,'text'|'mode'|'decorations'> & {origin?:PromptFillInput['origin']})[]=[];const diagnostics:unknown[]=[];let box:PromptBox={text:'',cursor:0}
 const runtime=createModsRuntime({onDiagnostic:d=>diagnostics.push(d),services:{prompt:()=>({read:()=>({...box}),fill:input=>{observed.push(structuredClone(input));box={text:input.text,cursor:input.text.length};return true}})}})
 runtimes.push(runtime);await runtime.bind({cwd:root,sessionId:'owned-fill-session',surface:'terminal',isInteractive:true});await runtime.reconcile([caller,policy]);expect(diagnostics).toEqual([])
 return{runtime,observed,diagnostics}
}

test('real Worker public fill leaves incoming hook raw then cleans next-rewritten text and UTF16 runs at core',async()=>{
 const {runtime,observed,diagnostics}=await setup(`on('prompt.fill',($,e,next)=>{if(e.text!==${JSON.stringify(raw)})throw Error('cleaned before hook');return next({...e,text:${JSON.stringify(rewritten)},decorations:${JSON.stringify(runs)}})});`)
 expect(await runtime.dispatch('tool.call',{text:raw,mode:'replace',decorations:[]},async()=>({result:'unexpected core'}))).toEqual({result:{isFilled:true,text:cleaned,cursor:cleaned.length}})
 expect(observed).toEqual([{text:cleaned,mode:'replace',decorations:mapped,origin:{kind:'plugin',name:'fill-caller'}}]);expect(diagnostics).toEqual([])
})

test('real Worker hook answer without next never reaches cleaning composer and keeps current box',async()=>{
 const {runtime,observed,diagnostics}=await setup(`on('prompt.fill',($,e)=>{if(e.text!==${JSON.stringify(raw)})throw Error('cleaned before hook');return {isFilled:false}});`)
 expect(await runtime.dispatch('tool.call',{text:raw,mode:'replace',decorations:[]},async()=>({result:'unexpected core'}))).toEqual({result:{isFilled:false,text:'',cursor:0}})
 expect(observed).toEqual([]);expect(diagnostics).toEqual([])
})

test('fill paint eligibility reads actual box after set instead of computed candidate',()=>{
 let box:PromptBox={text:'initial',cursor:0};const paints:unknown[]=[];let reads=0
 const result=fillPromptBox({read:()=>{reads++;return{...box}},set:()=>{box={text:'person replaced',cursor:15}},paint:(d,t)=>paints.push({d,t})},{text:'owned',mode:'replace',decorations:[{start:0,end:5,bold:true}]})
 expect(result).toBe(true);expect(paints).toEqual([]);expect(reads).toBe(2)
})

test('fill paint normalizes shifted runs against actual accepted full text',()=>{
 let box:PromptBox={text:'A',cursor:1};const paints:unknown[]=[]
 fillPromptBox({read:()=>({...box}),set:(text,cursor)=>{box={text:text+'Z',cursor}},paint:(decorations,text)=>paints.push({decorations,text})},{text:'😀',mode:'append',decorations:[{start:0,end:2,bold:true}]})
 expect(paints).toEqual([{decorations:[{start:1,end:3,bold:true}],text:'A😀Z'}])
})

test.each(['replace','append','insert'] as const)('fill %s switches to prompt only for replace before writing draft',mode=>{
 let box:PromptBox={text:'!',cursor:0};const trace:string[]=[]
 const host={read:()=>({...box}),set:(text:string,cursor:number)=>{trace.push('set:'+text);box={text,cursor}},setMode:(next:'prompt')=>trace.push('mode:'+next)}
 fillPromptBox(host,{text:'X',mode})
 expect(trace).toEqual(mode==='replace'?['mode:prompt','set:X']:mode==='append'?['set:!X']:['set:X!'])
})
