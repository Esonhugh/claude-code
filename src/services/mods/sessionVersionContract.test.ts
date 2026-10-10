import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime } from './runtime.js'
import { loadModDeclaration } from './loader.js'
let root:string
let runtime:ReturnType<typeof createModsRuntime>|undefined
const keys=['HOME','CLAUDE_CONFIG_DIR','ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN']
let saved:(string|undefined)[]
const globals=globalThis as typeof globalThis & {MACRO?:MacroGlobals}
let macro:MacroGlobals|undefined
beforeEach(async()=>{
  root=await realpath(await mkdtemp(join(tmpdir(),'mods-version-')))
  saved=keys.map(key=>process.env[key]);macro=globals.MACRO
  process.env.HOME=root;process.env.CLAUDE_CONFIG_DIR=join(root,'config');process.env.ANTHROPIC_API_KEY='sk-version-placeholder';delete process.env.CLAUDE_CODE_OAUTH_TOKEN
})
afterEach(async()=>{
  await runtime?.dispose();runtime=undefined
  if(macro===undefined)delete globals.MACRO;else globals.MACRO=macro
  keys.forEach((key,i)=>{if(saved[i]===undefined)delete process.env[key];else process.env[key]=saved[i]})
  await rm(root,{recursive:true,force:true})
})
async function register(extra='',body='return await $.session.version(...e.args)'){
  const entry=join(root,'register.mjs')
  await writeFile(entry,`export function register(on){${extra};on('tool.call',async($,e)=>{try{return {result:await(async()=>{${body}})()}}catch(error){return {result:{error:error.message,name:error.name}}}})}`)
  const declaration={name:'reader',storageId:'reader@fixture',pluginRoot:root,entrypoints:[entry]}
  expect((await loadModDeclaration(declaration)).calls).toContain('session.version')
  runtime=createModsRuntime();await runtime.reconcile([declaration])
}
async function read(args:unknown[]=[]){return (await runtime!.dispatch('tool.call',{args},async()=>({result:'missed'})) as {result:unknown}).result}
test('version is available before binding and follows real embedded metadata',async()=>{
  await register()
  const cases:[MacroGlobals|undefined,Record<string,string>][]=[
    [undefined,{version:'0.0.0-dev',base:'0.0.0-dev'}],
    [{VERSION:'2.1.292',BUILD_TIME:'2026-10-06T05:25:12Z'},{version:'2.1.292',base:'2.1.292',builtAt:'2026-10-06T05:25:12Z'}],
    [{VERSION:'2.1.292-dev.20261010.t100000.sha1234'},{version:'2.1.292-dev.20261010.t100000.sha1234',base:'2.1.292-dev'}],
    [{VERSION:'local-build',BUILD_TIME:''},{version:'local-build'}],
  ]
  for(const [value,expected] of cases){if(value===undefined)delete globals.MACRO;else globals.MACRO=value;expect(await read()).toEqual(expected)}
})
test('terminal and headless binding do not change the build identity',async()=>{
  await register();globals.MACRO={VERSION:'2.1.292',BUILD_TIME:'2026-10-06T05:25:12Z'}
  for(const isInteractive of [false,true]){await runtime!.bind({cwd:root,surface:isInteractive?'terminal':null,isInteractive,sessionId:'version-fixture'});expect(await read()).toEqual({version:'2.1.292',base:'2.1.292',builtAt:'2026-10-06T05:25:12Z'})}
})
// Official 2.1.292's JS version() discards extra arguments and dispatches {}.
test('extra JS arguments are ignored before middleware, while denials remain catchable',async()=>{
  await register(`let count=0;on('session.version',($,e)=>({deny:'VERSION_DENIED '+(++count)+' '+Object.keys(e).length}))`)
  for(const [index,args] of [[],[{}],[undefined],['ignored'],[1,2]].entries())expect(await read(args)).toEqual({name:'HooksError',error:'reader: $.session.version: VERSION_DENIED '+(index+1)+' 0'})
})
test('version middleware can replace the metadata and the public receipt is mutable',async()=>{
  await register(`on('session.version',()=>({value:{version:'project-build'}}))`,`const value=await $.session.version();return {value,frozen:Object.isFrozen(value)}`)
  expect(await read()).toEqual({value:{version:'project-build'},frozen:false})
})
test('engine.create continuation keeps version callable without a bound session',async()=>{
  await register(`on('engine.create',async($,e,next)=>{const beneath=await next(e);return {...beneath,versionReader:{read:()=>beneath.session.version()}}})`,`return $.versionReader.read()`)
  delete globals.MACRO;expect(await read()).toEqual({version:'0.0.0-dev',base:'0.0.0-dev'})
})

// Official 2.1.292 preserves these hook values; the declaration still describes
// the engine's own metadata rather than validating arbitrary middleware values.
test.each([null,{version:123}])('nonstandard middleware version values are returned verbatim: %j',async value=>{
  await register(`on('session.version',()=>({value:${JSON.stringify(value)}}))`)
  expect(await read()).toEqual(value)
})
test('mutating a version receipt cannot change the next read or the embedded build stamp',async()=>{
  await register('',`const first=await $.session.version();first.version='local mutation';const second=await $.session.version();return {first:first.version,second:second.version}`)
  globals.MACRO={VERSION:'2.1.292'}
  expect(await read()).toEqual({first:'local mutation',second:'2.1.292'})
  expect(globals.MACRO.VERSION).toBe('2.1.292')
})
