import {afterEach,beforeEach,expect,test} from 'bun:test'
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {initBuiltinPlugins} from './index.js'
import {clearBuiltinPlugins,getBuiltinPluginDefinition,getBuiltinPlugins,getShippedBuiltinModDeclaration,registerBuiltinPlugin} from '../builtinPlugins.js'
import {setIsInteractive} from '../../bootstrap/state.js'
import {prepareModPlugins} from '../../services/mods/plugins.js'
import {createModsRuntime} from '../../services/mods/runtime.js'
import {loadPluginsForContractValidation} from '../../utils/plugins/pluginLoader.js'
import {readOfficialShippedDiffContract, shippedDiffProvenance} from '../builtinShippedMods.js'
import {unzipArchive} from '../builtinMods.js'
import {createModHostOperations} from '../../services/mods/hostOperations.js'
import {getGlobalConfig} from '../../utils/config.js'
import builtinDiff from '../../commands/diff/index.js'
import {resetSettingsCache,setCachedSettingsForSource,setSessionSettingsCache} from '../../utils/settings/settingsCache.js'
let root:string
const previous=new Map<string,string|undefined>()
const runtimes:ReturnType<typeof createModsRuntime>[]=[]
beforeEach(async()=>{
 root=await mkdtemp(join(tmpdir(),'mods-startup-291-'))
 for(const key of ['HOME','CLAUDE_CONFIG_DIR','CLAUDE_CODE_PLUGIN_CACHE_DIR','CLAUDE_CODE_ENTRYPOINT','CLAUDE_CODE_CHILD_SESSION','CLAUDECODE','CLAUDE_CODE_BUILTIN_DIFF_ARCHIVE'])previous.set(key,process.env[key])
 for(const key of ['HOME','CLAUDE_CONFIG_DIR','CLAUDE_CODE_PLUGIN_CACHE_DIR'])process.env[key]=root
 for(const key of ['CLAUDE_CODE_ENTRYPOINT','CLAUDE_CODE_CHILD_SESSION','CLAUDECODE'])delete process.env[key]
 const config=getGlobalConfig();delete config.diffSidebarOpen;config.cachedGrowthBookFeatures={}
 setIsInteractive(true);clearBuiltinPlugins();resetSettingsCache()
 for(const source of ['userSettings','projectSettings','localSettings','policySettings'] as const)setCachedSettingsForSource(source,null)
 setSessionSettingsCache({settings:{},errors:[]})
})
afterEach(async()=>{
 await Promise.all(runtimes.splice(0).map(r=>r.dispose()));clearBuiltinPlugins();setIsInteractive(false);resetSettingsCache()
 for(const [key,value]of previous)if(value===undefined)delete process.env[key];else process.env[key]=value
 previous.clear();await rm(root,{recursive:true,force:true})
})
test('production startup exposes exactly the genuine shipped291 diff and actual loader admits its original Worker',async()=>{
 await initBuiltinPlugins()
 expect(getBuiltinPluginDefinition('diff')).toBeUndefined()
 expect(getBuiltinPluginDefinition('cc-plugin-diff')?.version).toBe('2.1.291')
 const loaded=getBuiltinPlugins().enabled.find(p=>p.name==='cc-plugin-diff')!
 expect(loaded).toBeDefined()
 const input=prepareModPlugins([loaded],{userSettings:null,flagSettings:null,policySettings:null,hookPolicy:{managedOnly:false,allDisabled:false}}).inputs[0]!
 const files=unzipArchive(await readFile(new URL('../../../assets/builtin-diff-2.1.291.zip',import.meta.url)))
 const metadata=new TextDecoder().decode(files['official/chunk-fbpekckc.js'].subarray(shippedDiffProvenance.metadataStart,shippedDiffProvenance.metadataEnd))
 const array=(key:string)=>JSON.parse(metadata.match(new RegExp(key+':(\\[[^\\]]*\\])'))![1]!)
 const declaration=getShippedBuiltinModDeclaration(input)!
 expect(declaration.events).toEqual(array('hooks'))
 expect(declaration.calls).toEqual(array('calls'))
 expect(declaration.runCommands).toEqual(array('runCommands'))
 expect(declaration.env).toEqual({reads:array('reads'),writes:array('writes')})
 const diagnostics:unknown[]=[]
 const runtime=createModsRuntime({services:{builtinCommands:()=>[builtinDiff],commands:()=>[builtinDiff]},onDiagnostic:e=>diagnostics.push(e)})
 runtimes.push(runtime);await runtime.bind({cwd:root,sessionId:'startup-291',surface:'terminal',isInteractive:true});await runtime.reconcile([input])
 expect(diagnostics).toEqual([]);expect(runtime.isDiffOwned()).toBe(true)
 expect(runtime.commands.list().map(c=>c.name)).toEqual(['diff'])
 expect(runtime.commands.projection([builtinDiff])).not.toContain(builtinDiff)
 await runtime.reconcile([]);expect(runtime.isDiffOwned()).toBe(false);expect(runtime.commands.projection([builtinDiff])).toEqual([builtinDiff])
})
test.each(['local-agent','remote','remote_cowork'])('production catalog excludes diff for %s',async entry=>{
 process.env.CLAUDE_CODE_ENTRYPOINT=entry;await initBuiltinPlugins()
 expect(getBuiltinPluginDefinition('cc-plugin-diff')).toBeUndefined();expect(getBuiltinPluginDefinition('diff')).toBeUndefined()
})
test('noninteractive cli has no available diff pane',async()=>{
 setIsInteractive(false);await initBuiltinPlugins()
 expect(getBuiltinPlugins().enabled.some(p=>p.name==='cc-plugin-diff'||p.name==='diff')).toBe(false)
})

test.each([false,true])('startup carries undefined Mod preference from native %s exactly once',async saved=>{
 getGlobalConfig().diffSidebarOpen=saved;await initBuiltinPlugins()
 const host=createModHostOperations({cwd:()=>root,storageId:'cc-plugin-diff@builtin',signal:new AbortController().signal})
 expect(await host.store.get('open')).toBe(saved)
 getGlobalConfig().diffSidebarOpen=!saved;await initBuiltinPlugins();expect(await host.store.get('open')).toBe(saved)
})
test('startup preserves an existing closed Mod preference rather than native true',async()=>{
 const host=createModHostOperations({cwd:()=>root,storageId:'cc-plugin-diff@builtin',signal:new AbortController().signal})
 await host.store.set('open',false);getGlobalConfig().diffSidebarOpen=true;await initBuiltinPlugins()
 expect(await host.store.get('open')).toBe(false)
})
test('availability pins its first offered flag but startup carry reads the current flag',async()=>{
 getGlobalConfig().cachedGrowthBookFeatures={tengu_quiet_dolphin:false};getGlobalConfig().diffSidebarOpen=true
 await initBuiltinPlugins();const definition=getBuiltinPluginDefinition('cc-plugin-diff')!
 expect(getBuiltinPlugins().enabled.some(p=>p.name==='cc-plugin-diff')).toBe(false)
 getGlobalConfig().cachedGrowthBookFeatures={tengu_quiet_dolphin:true}
 expect(definition.isAvailable?.()).toBe(false)
 const host=createModHostOperations({cwd:()=>root,storageId:'cc-plugin-diff@builtin',signal:new AbortController().signal})
 expect(await host.store.get('open')).toBeUndefined()
})
test.each([['claude-desktop',undefined,undefined,true],['claude-desktop','1',undefined,false],['claude-desktop',undefined,'1',false],['claude-desktop-3p',undefined,undefined,false]] as const)('noninteractive surface %s child=%s claudecode=%s gate',async(entry,child,claudecode,expected)=>{
 setIsInteractive(false);process.env.CLAUDE_CODE_ENTRYPOINT=entry
 if(child)process.env.CLAUDE_CODE_CHILD_SESSION=child
 if(claudecode)process.env.CLAUDECODE=claudecode
 await initBuiltinPlugins();expect(getBuiltinPlugins().enabled.some(p=>p.name==='cc-plugin-diff')).toBe(expected)
})
async function repo(){
 const git=(...args:string[])=>{const p=Bun.spawnSync(['git','-C',root,...args],{stdout:'pipe',stderr:'pipe'});if(p.exitCode!==0)throw Error(p.stderr.toString())}
 git('init','-q');git('config','user.name','fixture');git('config','user.email','fixture@localhost')
 await writeFile(join(root,'sample.txt'),'before\n');git('add','sample.txt');git('-c','commit.gpgsign=false','commit','-q','-m','fixture')
}
async function live(columns=120){
 const loaded=getBuiltinPlugins().enabled.find(p=>p.name==='cc-plugin-diff')!
 const input=prepareModPlugins([loaded],{userSettings:null,flagSettings:null,policySettings:null,hookPolicy:{managedOnly:false,allDisabled:false}}).inputs[0]!
 const diagnostics:unknown[]=[]
 const runtime=createModsRuntime({services:{builtinCommands:()=>[builtinDiff],commands:()=>[builtinDiff],uiPresentation:()=>({columns,rows:40,isFullscreen:true,composerEmpty:true,hasDialog:false,keyboardOwned:false}),messages:()=>[],captureUsage:()=>async()=>({startedAt:Date.now()-1000,context:{window:200000},rateLimits:[]})},onDiagnostic:e=>diagnostics.push(e)})
 runtimes.push(runtime);await runtime.bind({cwd:root,sessionId:'carry-291',surface:'terminal',isInteractive:true});await runtime.reconcile([input])
 await runtime.dispatch('ui.render',{surface:'terminal',component:'PromptHint',requestId:'hint',props:{},viewport:{columns,rows:40,isFullscreen:true}},async()=>({type:'Box',children:[]}))
 return {runtime,input,diagnostics}
}
test('production original first Write uses restored asked eligibility and accepted person close clears it across runtime replacement',async()=>{
 await repo();getGlobalConfig().diffSidebarOpen=true;await initBuiltinPlugins();const {runtime,diagnostics}=await live()
 await runtime.dispatch('tool.call',{tool:'Write',tool_use_id:'first',file_path:join(root,'sample.txt'),content:'after\n'},async()=>{await writeFile(join(root,'sample.txt'),'after\n');return{result:{filePath:join(root,'sample.txt')}}})
 await runtime.settle();expect(diagnostics).toEqual([])
 const pane=runtime.ui.getSnapshot().find(p=>p.id==='diff')!;expect(pane).toBeDefined();expect(pane.visible).toBe(true)
 await runtime.ui.close(pane.owner,pane.id,{kind:'person'});await runtime.dispose()
 const host=createModHostOperations({cwd:()=>root,storageId:'cc-plugin-diff@builtin',signal:new AbortController().signal})
 await host.store.set('open',true)
 const next=await live();let attempts=0
 next.runtime.registerHostHook({plugin:'host-observer',tier:'prepend',registration:{id:1,event:'ui.open',hasCatch:false},invoke:async(input,continuation)=>{attempts++;return continuation(input)}})
 await next.runtime.dispatch('tool.call',{tool:'Write',tool_use_id:'second',file_path:join(root,'sample.txt'),content:'again\n'},async()=>{await writeFile(join(root,'sample.txt'),'again\n');return{result:{filePath:join(root,'sample.txt')}}})
 await next.runtime.settle();expect(next.diagnostics).toEqual([]);expect(attempts).toBeGreaterThan(0)
 expect(next.runtime.ui.getSnapshot()).toEqual([])
})

test.each(['missing','tampered'])('latest package %s leaves startup alive and native available without legacy diff fallback',async kind=>{
 const archive=join(root,'candidate.zip')
 if(kind==='tampered'){
  const bytes=await readFile(new URL('../../../assets/builtin-diff-2.1.291.zip',import.meta.url));bytes[bytes.length-1]^=1;await writeFile(archive,bytes)
 }
 process.env.CLAUDE_CODE_BUILTIN_DIFF_ARCHIVE=archive;await initBuiltinPlugins()
 expect(getBuiltinPluginDefinition('cc-plugin-diff')).toBeUndefined();expect(getBuiltinPluginDefinition('diff')).toBeUndefined()
 const runtime=createModsRuntime({services:{builtinCommands:()=>[builtinDiff],commands:()=>[builtinDiff]}});runtimes.push(runtime)
 await runtime.bind({cwd:root,sessionId:'failed-package',surface:'terminal',isInteractive:true});await runtime.reconcile([])
 expect(runtime.isDiffOwned()).toBe(false);expect(runtime.commands.projection([builtinDiff])).toEqual([builtinDiff])
})
test.each(['plugin-close','denied-person-close','unload-reload'])('restored asked eligibility survives %s for the actual original diff',async action=>{
 await repo();getGlobalConfig().diffSidebarOpen=true;await initBuiltinPlugins();const {runtime,input}=await live()
 const edit=async(value:ReturnType<typeof createModsRuntime>,id:string)=>{
  await value.dispatch('tool.call',{tool:'Write',tool_use_id:id,file_path:join(root,'sample.txt'),content:id},async()=>{await writeFile(join(root,'sample.txt'),id+'\n');return{result:{filePath:join(root,'sample.txt')}}});await value.settle()
 }
 await edit(runtime,'first');const pane=runtime.ui.getSnapshot()[0]!;expect(pane.visible).toBe(true)
 if(action==='plugin-close')await runtime.ui.close(pane.owner,pane.id,{kind:'plugin',name:'cc-plugin-diff'})
 else if(action==='denied-person-close'){
  const unhook=runtime.registerHostHook({plugin:'host-deny',tier:'prepend',registration:{id:9,event:'ui.close',hasCatch:false},invoke:async()=>({deny:'kept by test hook'})})
  try{await expect(runtime.ui.close(pane.owner,pane.id,{kind:'person'})).rejects.toThrow('kept by test hook');expect(runtime.ui.getSnapshot()[0]!.visible).toBe(true)}finally{unhook()}
 }else{
  await runtime.reconcile([]);expect(runtime.ui.getSnapshot()).toEqual([]);await runtime.reconcile([input])
 }
 await runtime.dispose();const next=await live();await edit(next.runtime,'second')
 expect(next.diagnostics).toEqual([]);expect(next.runtime.ui.getSnapshot()[0]!.visible).toBe(true)
})
test('production original first Write opens at144 without an inherited preference',async()=>{
 await repo();await initBuiltinPlugins();const {runtime,diagnostics}=await live(144)
 await runtime.dispatch('tool.call',{tool:'Write',tool_use_id:'first',file_path:join(root,'sample.txt'),content:'after\n'},async()=>{await writeFile(join(root,'sample.txt'),'after\n');return{result:{filePath:join(root,'sample.txt')}}});await runtime.settle()
 expect(diagnostics).toEqual([]);expect(runtime.ui.getSnapshot()[0]!.visible).toBe(true);expect(runtime.isDiffOwned()).toBe(true)
})

test('read-only production discovery projects latest archived source without minting runtime identity',async()=>{
 const result=await loadPluginsForContractValidation();expect(result.errors).toEqual([]);expect(result.complete).toBe(true)
 expect(result.enabled.map(p=>p.name)).toContain('cc-plugin-diff');expect(result.enabled.map(p=>p.name)).not.toContain('diff')
 expect(getBuiltinPluginDefinition('cc-plugin-diff')).toBeUndefined()
 const plugin=result.enabled.find(p=>p.name==='cc-plugin-diff')!
 expect(plugin.manifest.version).toBe('2.1.291');expect(plugin.contractFiles?.['hooks/register.js']).toBeDefined()
 const input=prepareModPlugins([plugin],{userSettings:null,flagSettings:null,policySettings:null,hookPolicy:{managedOnly:false,allDisabled:false}}).inputs[0]!
 expect(getShippedBuiltinModDeclaration(input)).toBeUndefined()
})
test('read-only discovery keeps the actual pinned availability and legacy setting alias',async()=>{
 getGlobalConfig().cachedGrowthBookFeatures={tengu_quiet_dolphin:false};await initBuiltinPlugins()
 expect(getBuiltinPlugins().enabled.some(p=>p.name==='cc-plugin-diff')).toBe(false)
 getGlobalConfig().cachedGrowthBookFeatures={tengu_quiet_dolphin:true}
 expect((await loadPluginsForContractValidation()).enabled.some(p=>p.name==='cc-plugin-diff')).toBe(false)
 clearBuiltinPlugins();setSessionSettingsCache({settings:{enabledPlugins:{'diff@builtin':false}},errors:[]})
 expect((await loadPluginsForContractValidation()).enabled.some(p=>p.name==='cc-plugin-diff')).toBe(false)
})
test('known host availability facet is not copied onto spread definitions or arbitrary callbacks',async()=>{
 await initBuiltinPlugins();const contract=await readOfficialShippedDiffContract(new URL('../../../assets/builtin-diff-2.1.291.zip',import.meta.url).pathname)
 expect(()=>getBuiltinPlugins([contract.definition])).not.toThrow()
 expect(()=>getBuiltinPlugins([{...contract.definition}])).toThrow('without executing its callback')
 let called=0;registerBuiltinPlugin({name:'fixture',description:'fixture',isAvailable:()=>{called++;return true}})
 expect(()=>getBuiltinPlugins([])).toThrow('without executing its callback');expect(called).toBe(0)
})
