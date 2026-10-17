import {afterEach, beforeEach, expect, test} from 'bun:test'
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createModsRuntime} from './runtime.js'

let root: string
let runtime: ReturnType<typeof createModsRuntime> | undefined
const keys=['HOME','CLAUDE_CONFIG_DIR','ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN']
let saved: (string | undefined)[]
const values=[
  null,
  {},
  {
    "isAnswered": true,
    "text": "ok",
    "usage": {
      "input_tokens": 1,
      "output_tokens": 2,
      "cache_read_input_tokens": 0,
      "cache_creation_input_tokens": 0
    }
  },
  {
    "isAnswered": true,
    "text": "",
    "usage": {
      "input_tokens": 1,
      "output_tokens": 2,
      "cache_read_input_tokens": 0,
      "cache_creation_input_tokens": 0
    }
  },
  {
    "isAnswered": true,
    "text": "ok"
  },
  {
    "isAnswered": true,
    "text": "ok",
    "usage": {
      "input_tokens": 1,
      "output_tokens": 2,
      "cache_read_input_tokens": 0,
      "cache_creation_input_tokens": 0,
      "extra": 1
    }
  },
  {
    "isAnswered": true,
    "text": "ok",
    "usage": {
      "input_tokens": -1,
      "output_tokens": 2,
      "cache_read_input_tokens": 0,
      "cache_creation_input_tokens": 0
    }
  },
  {
    "isAnswered": false,
    "reason": "nothing-to-fork"
  },
  {
    "isAnswered": false,
    "reason": "nothing-to-fork",
    "extra": "allowed?"
  },
  {
    "isAnswered": false,
    "reason": "aborted",
    "usage": {
      "input_tokens": 1,
      "output_tokens": 2,
      "cache_read_input_tokens": 0,
      "cache_creation_input_tokens": 0
    }
  },
  {
    "isAnswered": false,
    "reason": "unknown",
    "usage": {
      "input_tokens": 1,
      "output_tokens": 2,
      "cache_read_input_tokens": 0,
      "cache_creation_input_tokens": 0
    }
  },
  {
    "isAnswered": false,
    "reason": "api-error",
    "status": 999,
    "error": "unknown",
    "usage": {
      "input_tokens": 1,
      "output_tokens": 2,
      "cache_read_input_tokens": 0,
      "cache_creation_input_tokens": 0
    }
  }
]
beforeEach(async () => {
  saved=keys.map(key => process.env[key])
  root=await realpath(await mkdtemp(join(tmpdir(),'mods-model-result-')))
  process.env.HOME=root;process.env.CLAUDE_CONFIG_DIR=join(root,'config')
  process.env.ANTHROPIC_API_KEY='test-model-result-placeholder'
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
})
afterEach(async () => {
  await runtime?.dispose();runtime=undefined
  keys.forEach((key,index) => {if(saved[index]===undefined)delete process.env[key];else process.env[key]=saved[index]})
  await rm(root,{recursive:true,force:true})
})
for (const method of ['complete','fork'] as const) test(`model.${method} passes through the provider value without deep result validation`,async () => {
  const caller=join(root,'caller.mjs'),provider=join(root,'provider.mjs')
  await writeFile(caller,`export function register(on){
    on('tool.call',async $ => {
      const values=[];
      for(let index=0;index<${values.length};index++) values.push(await $.model.${method}({${method==='complete'?"model:'sonnet',":''}prompt:'case-'+index}));
      return {result:values};
    });
  }`)
  await writeFile(provider,`const values=${JSON.stringify(values)};export function register(on){
    on('model.${method}',($,e)=>({value:values[Number(e.prompt.slice(5))]}));
  }`)
  const diagnostics: unknown[]=[]
  let coreCalls=0
  const unexpectedCore=async () => {coreCalls++;throw new Error('provider value was rejected')}
  runtime=createModsRuntime({services:{modelComplete:unexpectedCore,modelFork:unexpectedCore},onDiagnostic:event => diagnostics.push(event)})
  await runtime.bind({cwd:root,surface:'terminal',isInteractive:true,sessionId:'model-result'})
  await runtime.reconcile([
    {name:'caller',storageId:'caller@test',pluginRoot:root,entrypoints:[caller]},
    {name:'provider',storageId:'provider@test',pluginRoot:root,entrypoints:[provider]},
  ])
  // Official 2.1.292 native: value is opaque at the hook boundary, including malformed model payloads.
  // This runtime contract does not widen the official ModelCompleteResult/ModelForkResult author types.
  expect(await runtime.dispatch('tool.call',{tool:'ModelResult',args:{}},async () => ({result:'unexpected core'}))).toEqual({result:values})
  expect(coreCalls).toBe(0)
  expect(diagnostics).toEqual([])
})
