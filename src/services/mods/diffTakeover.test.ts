import {afterEach, beforeEach, expect, test} from 'bun:test'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {initializeOfficialBuiltinMods, materializeBuiltinModsArchive} from '../../plugins/builtinMods.js'
import {loadOfficialShippedDiffDefinition} from '../../plugins/builtinShippedMods.js'
import {clearBuiltinPlugins, getBuiltinPlugins, getBuiltinPluginDefinition, registerBuiltinPlugin} from '../../plugins/builtinPlugins.js'
import builtinDiff from '../../commands/diff/index.js'
import {resetSettingsCache, setCachedSettingsForSource, setSessionSettingsCache} from '../../utils/settings/settingsCache.js'
import {prepareModPlugins} from './plugins.js'
import {createModsRuntime} from './runtime.js'
import {loadSessionOnlyPlugins, mergePluginSources} from '../../utils/plugins/pluginLoader.js'
import {DiffController} from '../diff/controller.js'
import {createModsSession} from './session.js'

let root: string
const runtimes: ReturnType<typeof createModsRuntime>[] = []
const originalEnv = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_CACHE_DIR'].map(key => [key, process.env[key]] as const)
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mods-diff-ownership-'))
  for (const key of ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_CACHE_DIR']) process.env[key] = root
  resetSettingsCache()
  for (const source of ['userSettings', 'projectSettings', 'localSettings', 'policySettings'] as const) setCachedSettingsForSource(source, null)
  setSessionSettingsCache({settings:{},errors:[]})
  clearBuiltinPlugins()
})
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(value => value.dispose()))
  clearBuiltinPlugins()
  resetSettingsCache()
  for (const [key, value] of originalEnv) if (value === undefined) delete process.env[key]; else process.env[key] = value
  await rm(root, {recursive: true, force: true})
})
const settings = () => ({userSettings:null, flagSettings:null, policySettings:null, hookPolicy:{managedOnly:false,allDisabled:false}})
async function originalModule() {
  const archive = new URL('../../../assets/builtin-diff-2.1.292.zip', import.meta.url).pathname
  const packaged = await materializeBuiltinModsArchive(archive, join(root, 'original-package'))
  return join(packaged, 'official', 'chunk-01whafa0.js')
}
async function packagedDiff(legacy = false) {
  const target = join(root, 'mods')
  if (legacy) await initializeOfficialBuiltinMods(new URL('../../../assets/builtin-mods-2.1.277.zip', import.meta.url).pathname,target)
  else registerBuiltinPlugin(await loadOfficialShippedDiffDefinition(await originalModule(),join(target,'diff')))
  const loaded = getBuiltinPlugins().enabled.find(plugin => plugin.name === (legacy?'diff':'cc-plugin-diff'))!
  return {loaded, input:prepareModPlugins([loaded], settings()).inputs[0]!}
}
async function running(input: Awaited<ReturnType<typeof packagedDiff>>['input'], services: Parameters<typeof createModsRuntime>[0]['services'] = {}) {
  const diagnostics: unknown[] = [], logs: string[] = []
  const value = createModsRuntime({services:{
    builtinCommands:() => [builtinDiff], commands:() => [builtinDiff],
    uiPresentation:() => ({columns:144,rows:40,isFullscreen:true,composerEmpty:true,hasDialog:false,keyboardOwned:false}),
    uiLog:(_plugin,text) => logs.push(text), messages:() => [],
    captureUsage:() => async () => ({startedAt:Date.now()-1000,context:{window:200000},rateLimits:[]}),
    ...services,
  },onDiagnostic:event => diagnostics.push(event)})
  runtimes.push(value)
  await value.bind({cwd:root,sessionId:'diff-test',surface:'terminal',isInteractive:true})
  await value.reconcile([input])
  return {value,diagnostics,logs}
}
test('actual official292 hook registers /diff through the host builtin loader and unload restores native', async () => {
  const {input} = await packagedDiff()
  const {value, diagnostics, logs} = await running(input)
  expect(diagnostics).toEqual([])
  expect(logs).toEqual([])
  expect(value.commands.list().map(command => command.name)).toEqual(['diff'])
  expect(value.isDiffOwned()).toBe(true)
  expect(value.commands.projection([builtinDiff])).not.toContain(builtinDiff)
  const transitions:boolean[]=[]
  value.commands.subscribe(() => transitions.push(value.isDiffOwned()))
  await value.reconcile([])
  expect(value.isDiffOwned()).toBe(false)
  expect(value.commands.projection([builtinDiff])).toEqual([builtinDiff])
  expect(transitions).toContain(false)
})
test('object fields and copied prepared inputs do not mint builtin ownership', async () => {
  const {input} = await packagedDiff()
  const {value} = await running({...input, isNative:true, tier:'builtin'})
  expect(value.isDiffOwned()).toBe(false)
  expect(value.commands.projection([builtinDiff])).toEqual([builtinDiff])
})
test('official caught registration error stays live and disables native even without a Mod command', async () => {
  const {input} = await packagedDiff()
  const {value,diagnostics,logs} = await running(input, {builtinCommands:() => {throw Error('catalog unavailable')}})
  expect(diagnostics).toEqual([])
  expect(logs).toEqual([expect.stringContaining('catalog unavailable')])
  expect(value.isDiffOwned()).toBe(true)
  expect(value.commands.list()).toEqual([])
  expect(value.commands.projection([builtinDiff])).toEqual([])
})
test('plain registration, spread definitions and tampered artifact bytes cannot issue ownership', async () => {
  const definition=await loadOfficialShippedDiffDefinition(await originalModule(),join(root,'copy'))
  registerBuiltinPlugin({...definition})
  const loaded=getBuiltinPlugins().enabled.find(plugin=>plugin.name==='cc-plugin-diff')!
  const input=prepareModPlugins([loaded],settings()).inputs[0]!
  const {value}=await running(input)
  expect(value.isDiffOwned()).toBe(false)
  const fake=join(root,'tampered.js')
  const bytes=await readFile(await originalModule());bytes[bytes.length-1]^=1;await writeFile(fake,bytes)
  await expect(loadOfficialShippedDiffDefinition(fake,root)).rejects.toThrow('SHA-256 mismatch')
  const metadataCopy=join(root,'forged-package');await mkdir(metadataCopy)
  const moduleCopy=join(metadataCopy,'chunk-01whafa0.js')
  await writeFile(moduleCopy,await readFile(await originalModule()))
  const identity=await readFile(join(dirname(await originalModule()),'chunk-cnv756hy.js'))
  identity[identity.length-1]^=1
  await writeFile(join(metadataCopy,'chunk-cnv756hy.js'),identity)
  await expect(loadOfficialShippedDiffDefinition(moduleCopy,root)).rejects.toThrow('identity module SHA-256 mismatch')
})
test('contract-only discovery cannot mint canonical runtime identity',async()=>{
  const {loaded}=await packagedDiff()
  expect(loaded.name).toBe('cc-plugin-diff')
  expect(loaded.source).toBe('cc-plugin-diff@builtin')
  const contract=getBuiltinPlugins([]).enabled[0]!
  const [input]=prepareModPlugins([contract],settings()).inputs
  const {value}=await running(input!)
  expect(value.isDiffOwned()).toBe(false)
  expect(value.commands.projection([builtinDiff])).toEqual([builtinDiff])
})
test('mutating an issued definition or input coordinates revokes its opaque identity',async()=>{
  const {input}=await packagedDiff()
  input.isNative=true
  const {value}=await running(input)
  expect(value.isDiffOwned()).toBe(false)
  delete input.isNative
  const definition=getBuiltinPluginDefinition('cc-plugin-diff')!
  definition.path=join(root,'forged-path')
  await value.reconcile([input])
  expect(value.isDiffOwned()).toBe(false)
  expect(value.commands.projection([builtinDiff])).toEqual([builtinDiff])
})
test('disabled, unavailable and missing canonical registries restore the native command',async()=>{
  const {input}=await packagedDiff()
  const {value}=await running(input)
  setSessionSettingsCache({settings:{enabledPlugins:{'cc-plugin-diff@builtin':false,'diff@builtin':true}},errors:[]})
  await value.reconcile([])
  expect(value.isDiffOwned()).toBe(false)
  expect(getBuiltinPlugins().enabled.some(plugin=>plugin.name==='cc-plugin-diff')).toBe(false)
  expect(value.commands.projection([builtinDiff])).toEqual([builtinDiff])
  setSessionSettingsCache({settings:{enabledPlugins:{'cc-plugin-diff@builtin':true,'diff@builtin':false}},errors:[]})
  await value.reconcile([input])
  expect(value.isDiffOwned()).toBe(true)
  const definition=getBuiltinPluginDefinition('cc-plugin-diff')!
  definition.isAvailable=()=>false
  await value.reconcile([])
  expect(value.isDiffOwned()).toBe(false)
  expect(value.commands.projection([builtinDiff])).toEqual([builtinDiff])
  definition.isAvailable=()=>true
  await value.reconcile([input]);expect(value.isDiffOwned()).toBe(true)
  clearBuiltinPlugins();await value.reconcile([])
  expect(value.isDiffOwned()).toBe(false)
  expect(value.commands.projection([builtinDiff])).toEqual([builtinDiff])
})
test('shipped ordinary builtin admission can be refused and does not acquire a native seat',async()=>{
  const {input}=await packagedDiff()
  const policyRoot=join(root,'policy');await mkdir(policyRoot)
  const entry=join(policyRoot,'register.ts')
  await writeFile(entry,`export function register(on){on('plugin.register',($,e,next)=>e.name==='cc-plugin-diff'?{refuse:'ordinary diff denied'}:next(e))}`)
  const policy={name:'policy',storageId:'policy@test',pluginRoot:policyRoot,entrypoints:[entry],tier:'prepend' as const}
  const {value,diagnostics}=await running(policy)
  await value.reconcile([policy,input])
  expect(value.isDiffOwned()).toBe(false)
  expect(value.commands.projection([builtinDiff])).toEqual([builtinDiff])
  expect(diagnostics).toContainEqual(expect.objectContaining({plugin:'cc-plugin-diff',message:expect.stringContaining('ordinary diff denied')}))
})
test('a policy-refused shipped replacement relinquishes ownership and restores native',async()=>{
  const {input}=await packagedDiff()
  const {value}=await running(input)
  const command=value.commands.list()[0]
  const policyRoot=join(root,'reload-policy');await mkdir(policyRoot)
  const entry=join(policyRoot,'register.ts')
  await writeFile(entry,`export function register(on){on('plugin.register',($,e,next)=>e.name==='cc-plugin-diff'?{refuse:'replacement denied'}:next(e))}`)
  const policy={name:'reload-policy',storageId:'reload-policy@test',pluginRoot:policyRoot,entrypoints:[entry],tier:'prepend' as const}
  await value.reconcile([input,policy])
  expect(value.isDiffOwned()).toBe(true)
  input.options={newConfiguration:true}
  await value.reconcile([input,policy])
  expect(value.isDiffOwned()).toBe(false)
  expect(value.commands.list()).not.toContain(command)
  expect(value.commands.projection([builtinDiff])).toEqual([builtinDiff])
  await value.reconcile([policy])
  expect(value.isDiffOwned()).toBe(false)
})
test('session subscription publishes ownership and disposal restores native synchronously',async()=>{
  const {loaded}=await packagedDiff()
  const host=createModsSession({isTrusted:true,getSettings:settings,loadPlugins:async()=>[loaded]})
  const transitions:boolean[]=[]
  const unsubscribe=host.commands.subscribe(()=>transitions.push(host.isDiffOwned()))
  try{
    await host.bind({cwd:root,sessionId:'session-diff',surface:'terminal',isInteractive:true},undefined,{builtinCommands:()=>[builtinDiff],commands:()=>[builtinDiff],messages:()=>[],captureUsage:()=>async()=>({startedAt:Date.now()-1000,context:{window:200000},rateLimits:[]}),uiLog:()=>{}})
    expect(host.isDiffOwned()).toBe(true)
    expect(transitions).toContain(true)
    expect(host.commands.projection([builtinDiff])).not.toContain(builtinDiff)
    const disposal=host.dispose()
    expect(host.isDiffOwned()).toBe(false)
    expect(host.commands.projection([builtinDiff])).toEqual([builtinDiff])
    expect(transitions.at(-1)).toBe(false)
    await disposal
  } finally{unsubscribe();await host.dispose()}
})
test('genuine canonical inline loader identity can replace native; a same-name marketplace object cannot', async () => {
  const {loaded}=await packagedDiff()
  const inlineRoot=join(root,'inline')
  await mkdir(join(inlineRoot,'.claude-plugin'),{recursive:true});await mkdir(join(inlineRoot,'hooks'))
  await writeFile(join(inlineRoot,'.claude-plugin/plugin.json'),'{"name":"diff"}')
  await writeFile(join(inlineRoot,'hooks/hooks.json'),'{"modules":["./register.ts"]}')
  await writeFile(join(inlineRoot,'hooks/register.ts'),`export function register(on) {
    on('session.start',async($,e,next)=>{await $.command.register({name:'diff',description:'inline diff'});return next(e)});
  }`)
  const {plugins,errors}=await loadSessionOnlyPlugins([inlineRoot])
  expect(errors).toEqual([])
  const merged=mergePluginSources({session:plugins,marketplace:[],builtin:[loaded]})
  expect(merged.plugins).toEqual(plugins)
  const [input]=prepareModPlugins(merged.plugins,settings()).inputs
  const {value,diagnostics}=await running(input!)
  expect(diagnostics).toEqual([])
  expect(value.isDiffOwned()).toBe(true)
  expect(value.commands.list().map(command=>command.name)).toEqual(['diff'])
  await value.reconcile([])
  const untrusted={...plugins[0]!,source:'diff@marketplace',repository:'diff@marketplace'}
  const [spoof]=prepareModPlugins([untrusted],settings()).inputs
  await value.reconcile([spoof!])
  expect(value.isDiffOwned()).toBe(false)
  expect(value.commands.projection([builtinDiff])).toEqual([builtinDiff])
})
test('verified legacy277 healthy-owner replacement failure retains ownership; actual unload restores it', async () => {
  const {input} = await packagedDiff(true)
  const {value} = await running(input)
  const command = value.commands.list()[0]
  await writeFile(input.entrypoints[0]!, 'export function register(')
  await value.reconcile([input])
  expect(value.isDiffOwned()).toBe(true)
  expect(value.commands.list()[0]).toBe(command)
  await value.reconcile([])
  expect(value.isDiffOwned()).toBe(false)
})

test('actual official292 first successful main-thread edit opens its Pane and native stays suspended', async () => {
  const git=(...args:string[])=>{
    const child=Bun.spawnSync(['git','-C',root,...args],{stdout:'pipe',stderr:'pipe'})
    if(child.exitCode!==0) throw Error(child.stderr.toString())
  }
  git('init','-q');git('config','user.name','fixture');git('config','user.email','fixture@localhost')
  await writeFile(join(root,'sample.txt'),'before\n');git('add','sample.txt');git('-c','commit.gpgsign=false','commit','-q','-m','fixture baseline')
  const {input}=await packagedDiff()
  const {value,diagnostics,logs}=await running(input)
  const observations:unknown[]=[]
  for (const [index,event] of ['ui.render','tool.call','store.get','process.run','settings.read','env.get','ui.open'].entries()) value.registerHostHook({
    plugin:'fixture-observer',tier:'prepend',registration:{id:100+index,event,hasCatch:false},
    invoke:async(input,next)=>{const result=await next(input);const record=result as {value?:{exitCode?:number;stderr?:string}};
      observations.push({event,argv:input.argv,name:input.name,exitCode:record?.value?.exitCode,stderr:record?.value?.stderr});return result},
  })
  let nativeFetches=0
  const native=new DiffController({cwd:root,isEnabled:()=>!value.isDiffOwned(),createBackend:async()=>{nativeFetches++;return null}})
  const unwatch=native.watch()
  try {
    await value.dispatch('ui.render',{surface:'terminal',component:'PromptHint',requestId:'hint',props:{},viewport:{columns:144,rows:40,isFullscreen:true}},async()=>({type:'Box',children:[]}))
    const opened=Promise.withResolvers<void>()
    const unsubscribe=value.ui.subscribe(()=>{if(value.ui.getSnapshot().some(pane=>pane.visible))opened.resolve()})
    const timeout=setTimeout(()=>opened.reject(Error(`official diff first edit did not open: ${JSON.stringify({observations,diagnostics,logs,panes:value.ui.getSnapshot().map(({owner,clients,clientBindings,...pane})=>pane)})}`)),3000)
    let coreCalls=0
    try {
      await value.dispatch('tool.call',{tool:'Write',tool_use_id:'first',file_path:join(root,'sample.txt'),content:'after\n'},async()=>{
        coreCalls++;await writeFile(join(root,'sample.txt'),'after\n');return {result:{filePath:join(root,'sample.txt')}}
      })
      await opened.promise
    } finally {clearTimeout(timeout);unsubscribe()}
    expect(coreCalls).toBe(1)
    expect(diagnostics).toEqual([])
    expect(nativeFetches).toBe(0)
    const pane=value.ui.getSnapshot().find(pane=>pane.visible)!
    expect(pane.title).toBe('Diff')
    expect(pane.plugin).toBe('cc-plugin-diff')
    expect(value.isDiffOwned()).toBe(true)
    await value.ui.render()
    const painted=JSON.stringify(value.ui.getSnapshot()[0]?.tree)
    expect(painted).toContain('sample.txt')
    await value.ui.close(pane.owner,pane.id,{kind:'person'})
    expect(value.isDiffOwned()).toBe(true)
    expect(value.commands.projection([builtinDiff])).not.toContain(builtinDiff)
  } finally {unwatch();native.dispose()}
})

test('actual Worker death restores native before the one recovery republishes official ownership', async () => {
  const {input}=await packagedDiff()
  const RealWorker=globalThis.Worker, workers:Worker[]=[]
  globalThis.Worker=class extends RealWorker {constructor(url:string|URL,options?:WorkerOptions){super(url,options);workers.push(this)}} as typeof Worker
  let result:Awaited<ReturnType<typeof running>>
  try {result=await running(input)} finally {globalThis.Worker=RealWorker}
  const {value}=result!
  const transitions:boolean[]=[]
  value.commands.subscribe(()=>transitions.push(value.isDiffOwned()))
  const changed=Promise.withResolvers<void>()
  const unsubscribe=value.commands.subscribe(()=>{if(!value.isDiffOwned())changed.resolve()})
  workers[0]!.terminate()
  try {await changed.promise} finally {unsubscribe()}
  expect(transitions).toContain(false)
  await value.bind({cwd:root,sessionId:'diff-test',surface:'terminal',isInteractive:true})
  expect(value.isDiffOwned()).toBe(true)
  expect(transitions.at(-1)).toBe(true)
  expect(value.commands.list().map(command=>command.name)).toEqual(['diff'])
})
