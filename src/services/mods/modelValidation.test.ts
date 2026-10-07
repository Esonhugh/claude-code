import {afterEach, expect, test} from 'bun:test'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createModModelComplete} from './modelAdapter.js'
import {createModsRuntime} from './runtime.js'
import {resetSettingsCache, setSessionSettingsCache} from '../../utils/settings/settingsCache.js'
import type {SideQueryOptions} from '../../utils/sideQuery.js'

// Native 2.1.292 p5t and the owned parameter/Worker receipts.
const shape = 'takes { model, prompt }, the prompt a string or a list of blocks, each { text } and at most `cache: true`'
const response = {content:[{type:'text',text:'ok'}]}
const request = {model:'claude-sonnet-4-6',prompt:'data'}
const invalidNumbers: unknown[] = [0,-1,1.5,NaN,Infinity,null,'1']
const runtimes: ReturnType<typeof createModsRuntime>[] = []
const roots: string[] = []
afterEach(async () => {
  resetSettingsCache()
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root,{recursive:true,force:true})))
})

test.each(invalidNumbers)('complete rejects maxTokens %s with the native error and no model resolution', async maxTokens => {
  let calls=0,resolved=0
  const complete=createModModelComplete(async () => {calls++;return response},model => {resolved++;return model},()=>64000,'parameter-owner')
  await expect(complete({...request,maxTokens} as never)).rejects.toMatchObject({
    name:'HooksError',message:`parameter-owner: $.model.complete: maxTokens must be a positive integer (got ${String(maxTokens)})`,
  })
  expect(calls).toBe(0);expect(resolved).toBe(0)
})

test.each(invalidNumbers)('complete rejects timeoutMs %s in milliseconds with the native error', async timeoutMs => {
  let calls=0
  const complete=createModModelComplete(async()=>{calls++;return response},model=>model,()=>64000,'parameter-owner')
  await expect(complete({...request,timeoutMs} as never)).rejects.toMatchObject({
    name:'HooksError',message:`parameter-owner: $.model.complete: timeoutMs must be a positive integer of milliseconds (got ${String(timeoutMs)})`,
  })
  expect(calls).toBe(0)
})

test.each(['wrong','',null,17])('complete rejects effort %s with the native finite list and original value', async effort => {
  let calls=0
  const complete=createModModelComplete(async()=>{calls++;return response},model=>model,()=>64000,'parameter-owner')
  await expect(complete({...request,effort} as never)).rejects.toMatchObject({
    name:'HooksError',message:`parameter-owner: $.model.complete: effort must be one of low, medium, high, xhigh, max (got ${String(effort)})`,
  })
  expect(calls).toBe(0)
})

test.each([
  [{...request,prompt:17,maxTokens:0,timeoutMs:0,effort:'wrong'},shape],
  [{...request,maxTokens:0,timeoutMs:0,effort:'wrong'},'maxTokens must be a positive integer (got 0)'],
  [{...request,timeoutMs:0,effort:'wrong'},'timeoutMs must be a positive integer of milliseconds (got 0)'],
] as const)('complete preserves shape, output limit, deadline and effort validation order (%j)', async (input,message) => {
  let calls=0
  const complete=createModModelComplete(async()=>{calls++;return response},model=>model,()=>64000,'parameter-owner')
  await expect(complete(input as never)).rejects.toMatchObject({name:'HooksError',message:`parameter-owner: $.model.complete: ${message}`})
  expect(calls).toBe(0)
})

test.each([64001,9007199254740992])('complete checks integer maxTokens %s against the resolved model cap', async maxTokens => {
  let calls=0
  const complete=createModModelComplete(async()=>{calls++;return response},()=>request.model,()=>128000,'parameter-owner')
  await expect(complete({model:'sonnet',prompt:'data',maxTokens})).rejects.toMatchObject({
    name:'HooksError',message:`parameter-owner: $.model.complete: maxTokens ${maxTokens} is past what claude-sonnet-4-6 can produce in one reply (64000)`,
  })
  expect(calls).toBe(0)
})

test('complete reports the resolved model and its smaller output cap', async()=>{
  const complete=createModModelComplete(async()=>response,()=> 'claude-3-5-sonnet-20241022',()=>8192,'parameter-owner')
  await expect(complete({model:'legacy',prompt:'data',maxTokens:8193})).rejects.toMatchObject({
    name:'HooksError',message:'parameter-owner: $.model.complete: maxTokens 8193 is past what claude-3-5-sonnet-20241022 can produce in one reply (8192)',
  })
})

test('complete checks the allowlist before the output cap, preserving the authored model in the error', async()=>{
  setSessionSettingsCache({settings:{availableModels:[]},errors:[]})
  let calls=0,limits=0
  const complete=createModModelComplete(async()=>{calls++;return response},()=>request.model,()=>{limits++;return 8192},'parameter-owner')
  await expect(complete({model:'SoNnEt',prompt:'data',maxTokens:64001})).rejects.toMatchObject({
    name:'HooksError',message:'parameter-owner: $.model.complete: model "SoNnEt" is not in this organization\'s allowlist',
  })
  expect(calls).toBe(0);expect(limits).toBe(0)
})

test.each(['','  ','  Owned-MODEL  '])('complete delegates string model %j to the actual model parser', async model=>{
  const calls:SideQueryOptions[]=[]
  const complete=createModModelComplete(async input=>{calls.push(input);return response})
  await expect(complete({model,prompt:'data'})).resolves.toMatchObject({isAnswered:true,text:'ok'})
  expect(calls).toHaveLength(1);expect(calls[0]?.model).toBe(model.trim())
})

test.each([2147483648,9007199254740992])('complete accepts and clamps integer deadline %s without a transport failure', async timeoutMs=>{
  let used:AbortSignal|undefined
  const complete=createModModelComplete(async input=>{used=input.signal;return response},model=>model)
  await expect(complete({...request,timeoutMs})).resolves.toMatchObject({isAnswered:true,text:'ok'})
  expect(used?.aborted).toBe(false)
})

test('Worker completion keeps initial and rewritten shape checks, owner errors, deny and opaque values distinct', async()=>{
  const root=await mkdtemp(join(tmpdir(),'mods-model-validation-'));roots.push(root)
  const plugin=async(name:string,source:string)=>{
    const pluginRoot=join(root,name);await mkdir(pluginRoot);const entry=join(pluginRoot,'register.ts');await writeFile(entry,source)
    return {name,storageId:name+'@test',pluginRoot,entrypoints:[entry]}
  }
  const owner=await plugin('validation-owner',`export function register(on){
    on('tool.call',async($)=>{
      const results=[];
      for(const request of [{model:17,prompt:'bad'}, {model:'haiku',prompt:'max',maxTokens:0,timeoutMs:0,effort:'wrong'},
        {model:'haiku',prompt:'time',timeoutMs:0,effort:'wrong'}, {model:'haiku',prompt:'effort',effort:'wrong'}, {model:'haiku',prompt:'nan',maxTokens:NaN}, {model:'haiku',prompt:'infinity',timeoutMs:Infinity},
        {model:'haiku',prompt:'rewrite'}, {model:'haiku',prompt:'deny'}, {model:'haiku',prompt:'opaque'}]){
        try{results.push(await $.model.complete(request))}catch(error){results.push({name:error.name,message:error.message})}
      }
      return {result:results};
    });
  }`)
  const policy=await plugin('validation-policy',`export function register(on){
    on('model.complete',(_,e,next)=>{
      if(e.prompt==='rewrite')return next({...e,prompt:17});
      if(e.prompt==='deny')return {deny:'owned request held'};
      if(e.prompt==='opaque')return {value:17};
      return next(e);
    });
  }`)
  const runtime=createModsRuntime();runtimes.push(runtime)
  await runtime.bind({cwd:root,sessionId:'validation',surface:'terminal',isInteractive:true})
  await runtime.reconcile([owner,policy])
  expect(await runtime.dispatch('tool.call',{},async()=>({result:'core'}))).toEqual({result:[
    {name:'HooksError',message:`validation-owner: model.complete: ${shape} (host check)`},
    {name:'HooksError',message:'validation-owner: $.model.complete: maxTokens must be a positive integer (got 0)'},
    {name:'HooksError',message:'validation-owner: $.model.complete: timeoutMs must be a positive integer of milliseconds (got 0)'},
    {name:'HooksError',message:'validation-owner: $.model.complete: effort must be one of low, medium, high, xhigh, max (got wrong)'},
    {name:'HooksError',message:'validation-owner: $.model.complete: maxTokens must be a positive integer (got NaN)'},
    {name:'HooksError',message:'validation-owner: $.model.complete: timeoutMs must be a positive integer of milliseconds (got Infinity)'},
    {name:'HooksError',message:`model.complete: ${shape} (host check)`},
    {name:'HooksError',message:'validation-owner: $.model.complete: owned request held'},17,
  ]})
})


test.each(['','  ','  Owned-MODEL  '])('complete keeps native thinking allowance for unknown first-party model %j',async model=>{
  const calls:SideQueryOptions[]=[]
  const complete=createModModelComplete(async input=>{calls.push(input);return response})
  await complete({model,prompt:'data'})
  expect(calls[0]?.max_tokens).toBe(3072)
  expect(calls[0]).not.toHaveProperty('thinking')
})


test.each([
  ['-rejects_disabled_thinking','owned-model',false],
  ['rejects_disabled_thinking;owned-model=-rejects_disabled_thinking','owned-model',false],
  ['owned*=rejects_disabled_thinking;owned-model=-rejects_disabled_thinking','owned-model',false],
  ['unrelated=-rejects_disabled_thinking','owned-model',true],
  ['claude-sonnet-4-6=rejects_disabled_thinking','claude-sonnet-4-6',false],
  ['claude-opus-5-5=-rejects_disabled_thinking','claude-opus-5-5',false],
  ['rejects_disabled_thinking','',true],
] as const)('complete applies native thinking capability rules %j to %j',async (capabilities,model,required)=>{
  const original=process.env.CLAUDE_CODE_MODEL_CAPABILITIES
  process.env.CLAUDE_CODE_MODEL_CAPABILITIES=capabilities
  try{
    const calls:SideQueryOptions[]=[]
    const complete=createModModelComplete(async input=>{calls.push(input);return response},model=>model)
    await complete({model,prompt:'data'})
    expect(calls[0]?.max_tokens).toBe(required ? 3072 : 1024)
    if(required)expect(calls[0]).not.toHaveProperty('thinking')
    else expect(calls[0]?.thinking).toBe(false)
  }finally{
    if(original===undefined)delete process.env.CLAUDE_CODE_MODEL_CAPABILITIES
    else process.env.CLAUDE_CODE_MODEL_CAPABILITIES=original
  }
})


test('complete allowlist ignores the context suffix of the resolved model',async()=>{
  setSessionSettingsCache({settings:{availableModels:['claude-sonnet-4-6']},errors:[]})
  const calls:SideQueryOptions[]=[]
  const complete=createModModelComplete(async input=>{calls.push(input);return response},()=> 'claude-sonnet-4-6[1m]')
  await expect(complete({model:'sonnet[1m]',prompt:'data'})).resolves.toMatchObject({isAnswered:true,text:'ok'})
  expect(calls[0]?.model).toBe('claude-sonnet-4-6[1m]')
})
