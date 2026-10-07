import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {isDeepStrictEqual} from 'node:util'
import {getIsInteractive} from '../bootstrap/state.js'
import {getAllGrowthBookFeatures, getFeatureValue_CACHED_MAY_BE_STALE} from '../services/analytics/growthbook.js'
import {getGlobalConfig} from '../utils/config.js'
import {logForDebugging} from '../utils/debug.js'
import {createModHostOperations} from '../services/mods/hostOperations.js'
import {materializeBuiltinModsArchive, unzipArchive} from './builtinMods.js'
import {registerBuiltinPlugin,getBuiltinPluginDefinition} from './builtinPlugins.js'
import {clearPluginCache} from '../utils/plugins/pluginLoader.js'
import {dirname, join} from 'node:path'
import type {BuiltinPluginDefinition} from '../types/plugin.js'
import type {ModDeclaration} from '../services/mods/types.js'

const verifiedDefinitions = new WeakMap<BuiltinPluginDefinition, {coordinates:string;declaration:ModDeclaration}>()
function definitionCoordinates(definition:BuiltinPluginDefinition): string {
  return JSON.stringify({name:definition.name,path:definition.path,version:definition.version,hookModules:definition.hookModules})
}
export function isVerifiedOfficialShippedModDefinition(definition:BuiltinPluginDefinition): boolean {
  return verifiedDefinitions.get(definition)?.coordinates === definitionCoordinates(definition)
}
export function getVerifiedOfficialShippedModDeclaration(definition:BuiltinPluginDefinition): ModDeclaration | undefined {
  return isVerifiedOfficialShippedModDefinition(definition) ? structuredClone(verifiedDefinitions.get(definition)!.declaration) : undefined
}

// Exact decoded module from the verified 2.1.292 darwin-arm64 release artifact.
export const shippedDiffProvenance = Object.freeze({
  version:'2.1.292',
  name:'cc-plugin-diff',
  binarySha256:'97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f',
  moduleSha256:'6cd79b0d5118de9485b1268d64238019e3a41510c943eb17832b128fd976afd3',
  identityModule:'chunk-cnv756hy.js',
  identityModuleSha256:'86406ab18044de34edba1f7247b591268b86b1cff7522aaf07f1d67725f915c7',
  sourceStart:12068, sourceEnd:62473,
  sourceSha256:'ccafc3393958bc6e428f8909030d06af0e50e6db73f7308ec26ac286f27e97a4',
  metadataStart:5666,metadataEnd:6250,
  metadataSha256:'41ada677ee5d534b88f953e89e0b8261a7cc567d538b21678f41f7d3e45319ca',
})

/** Host package initialization only; a manifest or caller-provided scan cannot issue a declaration. */
export async function loadOfficialShippedDiffDefinition(modulePath:string, root:string): Promise<BuiltinPluginDefinition> {
  const bytes = await readFile(modulePath)
  const hash = (value:Uint8Array) => createHash('sha256').update(value).digest('hex')
  if (hash(bytes) !== shippedDiffProvenance.moduleSha256) throw new Error('Official shipped diff module SHA-256 mismatch')
  const identityBytes = await readFile(join(dirname(modulePath),shippedDiffProvenance.identityModule))
  if (hash(identityBytes) !== shippedDiffProvenance.identityModuleSha256) throw new Error('Official shipped diff identity module SHA-256 mismatch')
  const source = bytes.subarray(shippedDiffProvenance.sourceStart,shippedDiffProvenance.sourceEnd)
  if (hash(source) !== shippedDiffProvenance.sourceSha256) throw new Error('Official shipped diff source SHA-256 mismatch')
  const metadata = bytes.subarray(shippedDiffProvenance.metadataStart,shippedDiffProvenance.metadataEnd)
  if (hash(metadata) !== shippedDiffProvenance.metadataSha256) throw new Error('Official shipped diff metadata SHA-256 mismatch')
  const entry = join(root,'hooks','register.js')
  const description='The diff panel as a plugin pane: /diff, the changed files and their hunks beside the transcript, refreshed as Claude edits'
  const definition:BuiltinPluginDefinition = {name:shippedDiffProvenance.name,version:shippedDiffProvenance.version,description,
    manifest:{name:shippedDiffProvenance.name,version:shippedDiffProvenance.version,description},path:root,defaultEnabled:true,
    hookModules:[{configPath:join(root,'hooks','hooks.json'),paths:['./register.js']}],
  }
  const declaration:ModDeclaration = {name:shippedDiffProvenance.name,storageId:`${shippedDiffProvenance.name}@builtin`,version:shippedDiffProvenance.version,pluginRoot:root,
    entrypoints:[entry],modules:[{path:entry,source:`${new TextDecoder('utf-8',{fatal:true}).decode(source)}\nexport {ym as register};\n`}],links:[],
    // The module's original $n scan (bytes5666..6250), independently pinned above.
    events:['session.start','ui.render','command.run','ui.close','ui.focus','ui.scroll','tool.call','prompt.submit'],
    calls:['clock.after','clock.every','clock.now','command.register','env.get','fs.list','fs.read','fs.stat','process.run',
      'session.id','session.messages','session.usage','settings.read','store.get','store.set','telemetry.log','telemetry.mark',
      'ui.close','ui.invalidate','ui.log','ui.open','ui.resolve','ui.status'],
    runCommands:['clear','diff','resume'],
    env:{reads:['CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING'],writes:[]},nextTiers:[],options:{},tier:'builtin',fingerprint:hash(source),
  }
  verifiedDefinitions.set(definition,{coordinates:definitionCoordinates(definition),declaration:structuredClone(declaration)})
  return definition
}

export const shippedDiffArchiveSha256='745c46dae5714492d5fe0351df623579f82000d132db8df365bf690031d1cc65'
const paneRequests=new Set<string>()
const availabilityFacets=new WeakMap<BuiltinPluginDefinition,{callback:()=>boolean;read:()=>boolean}>()
const contractFacets=new WeakMap<BuiltinPluginDefinition,{coordinates:string;callback:()=>boolean;read:()=>boolean}>()
export function getOfficialShippedPaneRequests(): readonly {plugin:string;id:string}[] {
 return [...paneRequests].map(()=>({plugin:shippedDiffProvenance.name,id:'diff'}))
}
export function updateOfficialShippedPaneRequest(plugin:string,id:string,asked:boolean):void {
 if(plugin!=='cc-plugin-diff'||id!=='diff')return
 if(asked)paneRequests.add('cc-plugin-diff\0diff');else paneRequests.delete('cc-plugin-diff\0diff')
}
export function clearOfficialShippedPaneRequests():void {paneRequests.clear()}
/** Contract discovery can read the verified host facet without invoking plugin callbacks. */
export function getVerifiedShippedModAvailability(definition:BuiltinPluginDefinition): boolean|undefined {
 const facet=availabilityFacets.get(definition)
 if(facet&&isVerifiedOfficialShippedModDefinition(definition)&&definition.isAvailable===facet.callback)return facet.read()
 const contract=contractFacets.get(definition)
 return contract&&contract.coordinates===definitionCoordinates(definition)&&definition.isAvailable===contract.callback?contract.read():undefined
}
export function isOfficialShippedDiffCatalogAllowed(): boolean {
 const entrypoint=process.env.CLAUDE_CODE_ENTRYPOINT
 return entrypoint!=='local-agent'&&!entrypoint?.startsWith('remote')
}
function paneDrawable(): boolean {
 return getIsInteractive() || process.env.CLAUDE_CODE_ENTRYPOINT==='claude-desktop' &&
  !process.env.CLAUDE_CODE_CHILD_SESSION && !process.env.CLAUDECODE
}
function offeredNow(): boolean {
 if(!paneDrawable())return false
 // Reading an existing feature payload remains useful when network analytics are disabled.
 const features=getAllGrowthBookFeatures()
 return Boolean(features.tengu_quiet_dolphin ?? getFeatureValue_CACHED_MAY_BE_STALE('tengu_quiet_dolphin',true))
}
async function readShippedArchive(archivePath:string):Promise<{bytes:Uint8Array;files:Record<string,Uint8Array>}> {
 const bytes=await readFile(archivePath)
 if(createHash('sha256').update(bytes).digest('hex')!==shippedDiffArchiveSha256)throw new Error('Official shipped diff archive SHA-256 mismatch')
 const files=unzipArchive(bytes)
 const received=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(files['provenance.json']))
 if(!isDeepStrictEqual(received,shippedDiffProvenance))throw new Error('Official shipped diff package provenance mismatch')
 return {bytes,files}
}
export async function readOfficialShippedDiffContract(archivePath:string):Promise<{definition:BuiltinPluginDefinition;files:Record<string,Uint8Array>}> {
 const {files}=await readShippedArchive(archivePath)
 const prefix='cc-plugin-diff/'
 const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(files[prefix+'.claude-plugin/plugin.json']))
 const contractFiles=Object.fromEntries(Object.entries(files).filter(([name])=>name.startsWith(prefix)).map(([name,value])=>[name.slice(prefix.length),value]))
 const available=()=>{
  const current=getBuiltinPluginDefinition('cc-plugin-diff')
  return (current?getVerifiedShippedModAvailability(current):undefined) ?? offeredNow()
 }
 const definition:BuiltinPluginDefinition={name:manifest.name,version:manifest.version,description:manifest.description,manifest,path:`${archivePath}/cc-plugin-diff`,defaultEnabled:true,isAvailable:available}
 contractFacets.set(definition,{coordinates:definitionCoordinates(definition),callback:available,read:available})
 return {definition,files:contractFiles}
}
export async function initializeOfficialShippedDiff(archivePath:string,cacheRoot:string):Promise<void> {
 const {bytes}=await readShippedArchive(archivePath)
 const root=await materializeBuiltinModsArchive(archivePath,cacheRoot,{bytes})
 const definition=await loadOfficialShippedDiffDefinition(join(root,'official','chunk-01whafa0.js'),join(root,'cc-plugin-diff'))
 let pinned:boolean|undefined
 const available=()=>paneDrawable() && (pinned ??= offeredNow())
 definition.isAvailable=available
 availabilityFacets.set(definition,{callback:available,read:()=>paneDrawable() && (pinned ??= offeredNow())})
 registerBuiltinPlugin(definition)
 const offered=offeredNow()
 logForDebugging(`[ModsBuiltin] ${JSON.stringify({event:'package-registered',plugin:definition.name,version:definition.version,storageId:'cc-plugin-diff@builtin',archiveSha256:shippedDiffArchiveSha256,moduleSha256:shippedDiffProvenance.moduleSha256,offeredNow:offered})}`)
 if(offered){
  try{
   const host=createModHostOperations({cwd:()=>process.cwd(),storageId:'cc-plugin-diff@builtin',signal:new AbortController().signal})
   const saved=await host.store.get('open')
   const native=getGlobalConfig().diffSidebarOpen
   if(saved===undefined&&native!==undefined){await host.store.set('open',native);logForDebugging(`diff: carried the built-in panel's saved preference (${native})`)}
   if((saved??native)===true)paneRequests.add('cc-plugin-diff\0diff')
  }catch(error){logForDebugging(`diff: the panel preference did not carry: ${error}`)}
 }
 clearPluginCache('official shipped diff registered')
}
