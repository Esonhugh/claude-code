import {expect,test} from 'bun:test'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {setIsInteractive} from '../../bootstrap/state.js'
import {enableConfigs} from '../../utils/config.js'
import {clearBuiltinPlugins,getBuiltinPluginDefinition} from '../builtinPlugins.js'
import {initBuiltinPlugins} from './index.js'

test('production initializer registers the pinned latest diff instead of the legacy diff',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'mods-version-291-')))
 const keys=['HOME','CLAUDE_CONFIG_DIR','CLAUDE_CODE_PLUGIN_CACHE_DIR','CLAUDE_CODE_ENTRYPOINT','CLAUDE_CODE_BUILTIN_DIFF_ARCHIVE'] as const
 const previous=new Map(keys.map(key=>[key,process.env[key]]))
 try{
  process.env.HOME=root;process.env.CLAUDE_CONFIG_DIR=root;process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR=root
  delete process.env.CLAUDE_CODE_ENTRYPOINT;delete process.env.CLAUDE_CODE_BUILTIN_DIFF_ARCHIVE
  enableConfigs();setIsInteractive(true);clearBuiltinPlugins()
  await initBuiltinPlugins()
  expect(getBuiltinPluginDefinition('cc-plugin-diff')?.version).toBe('2.1.291')
  expect(getBuiltinPluginDefinition('diff')).toBeUndefined()
 }finally{
  clearBuiltinPlugins();setIsInteractive(false)
  for(const [key,value]of previous)if(value===undefined)delete process.env[key];else process.env[key]=value
  await rm(root,{recursive:true,force:true})
 }
})
