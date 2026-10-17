import {afterEach, expect, test} from 'bun:test'
import {lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import ts from 'typescript'
import type {LoadedPlugin} from '../../types/plugin.js'
import {verifyAndDemote} from '../../utils/plugins/dependencyResolver.js'
import {prepareModPlugins} from './plugins.js'
import {ensureModDeclarations} from './declarations.js'
import {createModsRuntime} from './runtime.js'

const roots:string[]=[]
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))})
async function fixture(){const root=await realpath(await mkdtemp(join(tmpdir(),'owned-author-deps-')));roots.push(root);return root}
const settings={userSettings:null,flagSettings:null,policySettings:null,hookPolicy:{managedOnly:false,allDisabled:false}}
function plugin(name:string,dependencies:string[]=[],types?:string,source=`${name}@inline`):LoadedPlugin{return{name,path:`/owned/${name}`,source,repository:source,enabled:true,manifest:{name,dependencies,...types===undefined?{}:{types}}}}
function owner(dependencies:string[]):LoadedPlugin{return{...plugin('owner',dependencies),hookModules:[{configPath:'/owned/owner/hooks/hooks.json',paths:['../code/register.ts']}]}}
function prepared(plugins:LoadedPlugin[]){const result=prepareModPlugins(plugins,settings);expect(result.errors).toEqual([]);return result.inputs[0]!}
async function config(root:string){return JSON.parse(await readFile(join(root,'.claude-plugin/types/tsconfig.json'),'utf8'))}
async function dependency(name:string,text=`import type {} from 'claude-code';declare module 'claude-code'{interface PluginState{'${name}':{count:number}}}\n`){const pluginRoot=await fixture();await mkdir(join(pluginRoot,'contracts'));await writeFile(join(pluginRoot,'contracts/index.d.ts'),text);return{name,pluginRoot,path:'./contracts/index.d.ts'}}
function diagnostics(root:string){const path=join(root,'tsconfig.json'),input=ts.readConfigFile(path,ts.sys.readFile),parsed=ts.parseJsonConfigFileContent(input.config,ts.sys,root,{skipLibCheck:false},path);return[...parsed.errors,...ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames,parsed.options))].map(item=>ts.flattenDiagnosticMessageText(item.messageText,'\n'))}
const core=['claude-code','claude-code-tools','claude-code-mcp']

test('author roots use the loaded-order breadth-first dependency closure, including type-less bridges and cycles',()=>{
 const p=owner(['bridge','direct','bridge']),bridge=plugin('bridge',['leaf','owner','direct']),leaf=plugin('leaf',['bridge'],'./leaf.d.ts'),direct=plugin('direct',[],'./direct.d.ts')
 const duplicate=plugin('direct',[],'./wrong.d.ts','direct@other'),disabled={...plugin('leaf',['unrelated'],'./disabled.d.ts','leaf@disabled'),enabled:false}
 expect(prepared([p,leaf,direct,bridge,duplicate,disabled,plugin('unrelated',[],'./other.d.ts')]).authorTypeDependencies).toEqual([
  {name:'direct',pluginRoot:direct.path,path:'./direct.d.ts'},{name:'leaf',pluginRoot:leaf.path,path:'./leaf.d.ts'}])
})

test('qualified dependencies accept same-name inline overrides but not another marketplace or builtin',()=>{
 const p={...owner(['dep'] ),source:'owner@market'},wrong=plugin('dep',[],'./wrong.d.ts','dep@other'),builtin=plugin('dep',[],'./builtin.d.ts','dep@builtin'),inline=plugin('dep',[],'./inline.d.ts'),matching=plugin('dep',[],'./matching.d.ts','dep@market')
 expect(prepared([p,wrong,builtin,inline,matching]).authorTypeDependencies).toEqual([{name:'dep',pluginRoot:inline.path,path:'./inline.d.ts'}])
 expect(verifyAndDemote([p,inline])).toEqual({demoted:new Set(),errors:[]})
 expect(verifyAndDemote([p,wrong]).demoted).toEqual(new Set(['owner@market']))
 expect(verifyAndDemote([p,builtin]).demoted).toEqual(new Set(['owner@market']))
})

test.each(['inline','skills-dir','synced'])('synthetic %s sources do not qualify a bare dependency',source=>{
 const p={...owner(['dep']),source:`owner@${source}`},dep=plugin('dep',[],'./index.d.ts','dep@market')
 expect(prepared([p,dep]).authorTypeDependencies).toEqual([{name:'dep',pluginRoot:dep.path,path:'./index.d.ts'}])
})

test('dependency contracts are linked as exact type roots and strict author types exclude unrelated contracts',async()=>{
 const root=await fixture(),dep=await dependency('typed-dep');await mkdir(join(root,'tests'))
 await writeFile(join(root,'tests/author.ts'),`import type {StateDollar} from 'claude-code';declare const $:StateDollar;async function check(){const result=await $.state.get({plugin:'typed-dep',key:'count'});const value:number|undefined=result.value;void value;
 // @ts-expect-error Dependency values retain their contract.
 await $.state.set({plugin:'typed-dep',key:'count'},'wrong');
 // @ts-expect-error Unrelated plugins are not projected.
 await $.state.get({plugin:'unrelated',key:'count'});}`)
 const installed=await ensureModDeclarations(root,'2.1.291',[],[],[dep])
 expect((await config(root)).compilerOptions.types).toEqual([...core,'typed-dep'])
 expect(installed.entries).toEqual([...core,'typed-dep'])
 expect(await readlink(join(installed.root,'typed-dep/index.d.ts'))).toBe(join(dep.pluginRoot,'contracts/index.d.ts'))
 expect(diagnostics(root)).toEqual([])
 expect((await ensureModDeclarations(root,'2.1.291',[],[],[dep])).written).toEqual([])
})

test('failed link replacement copies a regular bounded declaration and strips its BOM',async()=>{
 const root=await fixture(),dep=await dependency('copied','\ufeffexport {};\n'),index=join(root,'.claude-plugin/types/copied/index.d.ts')
 await mkdir(index,{recursive:true});await writeFile(join(index,'owned-sentinel'),'generated target\n')
 await ensureModDeclarations(root,'2.1.291',[],[],[dep])
 expect((await lstat(index)).isSymbolicLink()).toBe(false)
 expect(await readFile(index,'utf8')).toBe('export {};\n')
 expect((await config(root)).compilerOptions.types).toEqual([...core,'copied'])
})

test('copy fallback rejects a source over 256 KiB without removing the failed target',async()=>{
 const root=await fixture(),dep=await dependency('large','x'.repeat(262145)),index=join(root,'.claude-plugin/types/large/index.d.ts')
 await mkdir(index,{recursive:true});await writeFile(join(index,'owned-sentinel'),'preserved\n')
 await expect(ensureModDeclarations(root,'2.1.291',[],[],[dep])).rejects.toThrow(/size cap/)
 expect(await readFile(join(index,'owned-sentinel'),'utf8')).toBe('preserved\n')
})

test('retiring edited generated indexes preserves author siblings and the custom root config',async()=>{
 const root=await fixture(),a=await dependency('retired-a'),b=await dependency('retired-b')
 await ensureModDeclarations(root,'2.1.291',[],[],[a,b]);const types=join(root,'.claude-plugin/types'),index=join(types,'retired-a/index.d.ts'),keep=join(types,'retired-a/author.keep')
 await rm(index);await writeFile(index,'// altered generated index\n');await writeFile(keep,'author sibling\n')
 const authorConfig='{"extends":"./.claude-plugin/types/tsconfig.json","compilerOptions":{"noUnusedLocals":false}}\n';await writeFile(join(root,'tsconfig.json'),authorConfig);const before=await stat(join(root,'tsconfig.json'))
 const old=await config(root);old.compilerOptions.strict=false;await writeFile(join(types,'tsconfig.json'),JSON.stringify(old)+'\n');await writeFile(join(types,'claude-code/index.d.ts'),'// altered generated base\n')
 const result=await ensureModDeclarations(root,'2.1.291',[],[],[])
 expect(result.written).toContain('retired-a');expect(result.written).toContain('retired-b')
 expect((await config(root)).compilerOptions.types).toEqual(core);expect((await config(root)).compilerOptions.strict).toBe(true)
 await expect(lstat(index)).rejects.toMatchObject({code:'ENOENT'});await expect(lstat(join(types,'retired-b'))).rejects.toMatchObject({code:'ENOENT'})
 expect(await readFile(keep,'utf8')).toBe('author sibling\n');expect(await readFile(join(types,'claude-code/index.d.ts'),'utf8')).toContain('export type StateDollar')
 expect(await readFile(join(root,'tsconfig.json'),'utf8')).toBe(authorConfig);expect((await stat(join(root,'tsconfig.json'))).mtimeMs).toBe(before.mtimeMs)
})

test('unsafe names and escaping, missing or non-file contracts never become type roots',async()=>{
 const root=await fixture(),dep=await dependency('valid'),outside=await fixture();await writeFile(join(outside,'outside.d.ts'),'export {};\n');await symlink(join(outside,'outside.d.ts'),join(dep.pluginRoot,'contracts/escape.d.ts'))
 const names=['','.', '..','CLAUDE-CODE','claude-code-tools','claude-code-mcp','TSCONFIG.JSON','.GITIGNORE','a/b','a\\b','a:b','a@b','a b','a\u2800b','a\uE000b','a\u200bb']
 await ensureModDeclarations(root,'2.1.291',[],[],[...names.map(name=>({...dep,name})),{...dep,name:'escaped',path:'./contracts/escape.d.ts'},{...dep,name:'missing',path:'./missing.d.ts'},{...dep,name:'directory',path:'./contracts'},{...dep,name:'traversal',path:'../outside.d.ts'}])
 expect((await config(root)).compilerOptions.types).toEqual(core)
})

test('generated package directory symlinks are replaced without touching their external targets',async()=>{
 const root=await fixture(),dep=await dependency('linked-dir'),outside=await fixture();await writeFile(join(outside,'index.d.ts'),'outside remains\n');await mkdir(join(root,'.claude-plugin/types'),{recursive:true});await symlink(outside,join(root,'.claude-plugin/types/linked-dir'))
 await ensureModDeclarations(root,'2.1.291',[],[],[dep]);expect((await lstat(join(root,'.claude-plugin/types/linked-dir'))).isDirectory()).toBe(true);expect(await readFile(join(outside,'index.d.ts'),'utf8')).toBe('outside remains\n')
})

test('runtime reconciliation refreshes dependency roots even when the hook declaration is unchanged',async()=>{
 const root=await fixture(),dep=await dependency('runtime-dep');await mkdir(join(root,'hooks'));const entry=join(root,'hooks/register.mjs');await writeFile(entry,"export function register(on){on('session.start',(_,e,next)=>next(e))}\n")
 const errors:unknown[]=[],runtime=createModsRuntime({onDiagnostic:e=>errors.push(e)});const input={name:'owner',storageId:'owner@inline',pluginRoot:root,entrypoints:[entry],authorTypeDependencies:[dep]}
 try{await runtime.bind({cwd:root,surface:null,isInteractive:false,sessionId:'owned-types'});await runtime.reconcile([input]);expect((await config(root)).compilerOptions.types).toEqual([...core,'runtime-dep']);await runtime.reconcile([{...input,authorTypeDependencies:[]}]);expect((await config(root)).compilerOptions.types).toEqual(core);expect(errors).toEqual([])}finally{await runtime.dispose()}
})


test('real and linked root spellings converge on a complete project after an interrupted write',async()=>{
 const root=await fixture(),parent=await fixture(),alias=join(parent,'plugin');await symlink(root,alias)
 await mkdir(join(root,'.claude-plugin/types/claude-code'),{recursive:true});await writeFile(join(root,'.claude-plugin/types/claude-code/index.d.ts'),'// truncated declaration');await writeFile(join(root,'.claude-plugin/types/tsconfig.json'),'{"partial":')
 await mkdir(join(root,'tests'));await writeFile(join(root,'tests/author.ts'),"import type {Color} from 'claude-code';const color:Color='diffAdded';void color;\n")
 const results=await Promise.all([ensureModDeclarations(root,'2.1.291',[]),ensureModDeclarations(alias,'2.1.291',[])])
 expect(results.every(result=>result.root===join(root,'.claude-plugin/types'))).toBe(true)
 expect((await config(root)).compilerOptions.types).toEqual(core)
 expect(await readFile(join(root,'.claude-plugin/types/.gitignore'),'utf8')).toBe('*\n')
 expect(await readFile(join(root,'.claude-plugin/types/claude-code/index.d.ts'),'utf8')).toContain('export type StateDollar')
 expect(diagnostics(root)).toEqual([])
})

test('absent tool snapshots preserve existing auxiliary files until an explicit snapshot replaces them',async()=>{
 const root=await fixture();const project=await ensureModDeclarations(root,'2.1.291');const builtin=join(project.root,'claude-code-tools/index.d.ts'),mcp=join(project.root,'claude-code-mcp/index.d.ts')
 await writeFile(builtin,'// author builtin snapshot\n');await writeFile(mcp,'// author MCP snapshot\n')
 await ensureModDeclarations(root,'2.1.291')
 expect(await readFile(builtin,'utf8')).toBe('// author builtin snapshot\n');expect(await readFile(mcp,'utf8')).toBe('// author MCP snapshot\n')
 await ensureModDeclarations(root,'2.1.291',[])
 expect(await readFile(builtin,'utf8')).toContain('BuiltinToolInputs');expect(await readFile(mcp,'utf8')).toBe('// author MCP snapshot\n')
})

test('malformed previous type lists do not authorize deletion outside generated package names',async()=>{
 const root=await fixture(),dep=await dependency('active');await ensureModDeclarations(root,'2.1.291',[],[],[dep]);const outside=join(root,'author.keep');await writeFile(outside,'author data\n')
 const old=await config(root);old.compilerOptions.types=['../../author.keep','claude-code','TSCONFIG.JSON','.gitignore'];await writeFile(join(root,'.claude-plugin/types/tsconfig.json'),JSON.stringify(old))
 await ensureModDeclarations(root,'2.1.291',[],[],[dep]);expect(await readFile(outside,'utf8')).toBe('author data\n');expect((await config(root)).compilerOptions.types).toEqual([...core,'active'])
})
