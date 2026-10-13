import {afterEach,beforeEach,expect,test} from 'bun:test'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createModsRuntime} from './runtime.js'
let root:string
const runtimes:ReturnType<typeof createModsRuntime>[]=[]
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'mods-public-config-origin-'))})
afterEach(async()=>{await Promise.all(runtimes.splice(0).map(runtime=>runtime.dispose()));await rm(root,{recursive:true,force:true})})
function createRuntime(){
 const runtime=createModsRuntime({services:{configRows:()=>[{key:'fixture',label:'core',kind:'boolean',value:false,provider:{plugin:'engine',tier:'core'},isLocked:false}]}})
 runtimes.push(runtime);return runtime
}
async function register(runtime:ReturnType<typeof createModsRuntime>,counter=false){
 const entry=join(root,'register.ts')
 await writeFile(entry,`let reads=0;export function register(on){on('config.describe',($,e,next)=>({label:next.origin.plugin+':'+next.origin.tier${counter?"+':'+(++reads)":''},isHidden:false}));on('tool.call',async $=>({result:await $.config.list()}))}`)
 await runtime.reconcile([{name:'caller',storageId:'caller@test',pluginRoot:root,entrypoints:[entry]}])
}
test('public config.list describes rows with the actual caller origin',async()=>{
 const runtime=createRuntime();await register(runtime)
 expect(await runtime.dispatch('tool.call',{},async()=>({result:'core'}))).toMatchObject({result:[{label:'caller:user'}]})
})
test('public config.list bypasses the engine menu cache and recomputes each caller projection',async()=>{
 const runtime=createRuntime();await register(runtime,true)
 expect(await runtime.config.list()).toMatchObject([{label:'engine:core:1'}])
 expect(await runtime.dispatch('tool.call',{},async()=>({result:'core'}))).toMatchObject({result:[{label:'caller:user:2'}]})
 expect(await runtime.dispatch('tool.call',{},async()=>({result:'core'}))).toMatchObject({result:[{label:'caller:user:3'}]})
 expect(await runtime.config.list()).toMatchObject([{label:'engine:core:1'}])
})
