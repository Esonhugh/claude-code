import {afterEach, expect, test} from 'bun:test'
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createModModelComplete} from './modelAdapter.js'
import {normalizeModModelCompleteRequest, projectModModelText, validateModModelCompleteInput} from './modelTextBlocks.js'
import {createModsRuntime} from './runtime.js'
import type {SideQueryOptions} from '../../utils/sideQuery.js'

// Official 2.1.292 Tf/l5t/d5t and the owned native model-complete receipts.
const marked = (text: string) => ({type:'text' as const, text, cache_control:{type:'ephemeral' as const}})
const plain = (text: string) => ({type:'text' as const, text})
const blocks = [{text:'ab',cache:true},{text:'cd',cache:true}]
test.each([
  ['abcd', blocks, [marked('ab'),marked('cd')]],
  ['abcd tail', blocks, [marked('ab'),marked('cd'),plain(' tail')]],
  ['abCHANGED', blocks, [marked('ab'),plain('CHANGED')]],
  ['new opening', blocks, 'new opening'],
  ['', blocks, ''],
  ['abcd', [{text:'',cache:true},...blocks], [marked(''),marked('ab'),marked('cd')]],
  ['abcd', [{text:'ab',cache:false},{text:'cd'}], [plain('ab'),plain('cd')]],
  ['😀tail', [{text:'😀',cache:true}], [marked('😀'),plain('tail')]],
  ['\ud800tail', [{text:'\ud800',cache:true}], '\ud800tail'],
  ['ab\udc00tail', [{text:'ab',cache:true},{text:'\udc00',cache:true}], [marked('ab'),plain('\udc00tail')]],
] as const)('completion retains only unchanged leading cache blocks (%s)', (text, input, expected) => {
  expect(projectModModelText(text, input)).toEqual(typeof expected === 'string' ? expected : [...expected])
})

test('public request normalization preserves unknown fields and drops falsy scalar system', () => {
  expect(normalizeModModelCompleteRequest({model:'haiku',prompt:blocks,system:[{text:'rules',cache:true}],extra:7})).toEqual({
    model:'haiku',prompt:'abcd',promptBlocks:blocks,system:'rules',systemBlocks:[{text:'rules',cache:true}],extra:7,
  })
  expect(normalizeModModelCompleteRequest({model:'haiku',prompt:[],system:[]})).toEqual({model:'haiku',prompt:'',promptBlocks:[],system:'',systemBlocks:[]})
  for (const system of ['',false,null,0,undefined]) {
    expect(normalizeModModelCompleteRequest({model:'haiku',prompt:'x',system})).toEqual({model:'haiku',prompt:'x'})
  }
})

test('invalid author blocks fail the host shape check before any hook is called', () => {
  for (const prompt of [[{text:'x',extra:1}],[{text:1}],[{text:'x',cache:'yes'}],Array(1)]) {
    expect(() => validateModModelCompleteInput(normalizeModModelCompleteRequest({model:'haiku',prompt}),'owner')).toThrow('owner: model.complete: takes { model, prompt }')
  }
  expect(() => validateModModelCompleteInput({model:'haiku',prompt:'x',promptBlocks:[{text:'x',extra:1}]})).toThrow('promptBlocks and systemBlocks')
})

test('completion projects edited blocks into the tool-less side query and concatenates response text', async () => {
  const calls: SideQueryOptions[] = []
  const complete = createModModelComplete(async request => {
    calls.push(request)
    return {content:[{type:'text',text:'one'},{type:'thinking'},{type:'text',text:'two'}],usage:{input_tokens:1,output_tokens:2,cache_read_input_tokens:3,cache_creation_input_tokens:4}}
  }, () => 'claude-sonnet-4-6', () => 64000)
  expect(await complete({model:'sonnet',prompt:'abNEW',promptBlocks:blocks,system:'rules extra',systemBlocks:[{text:'rules',cache:true}],maxTokens:17,effort:'low'})).toEqual({
    isAnswered:true,text:'onetwo',usage:{input_tokens:1,output_tokens:2,cache_read_input_tokens:3,cache_creation_input_tokens:4},
  })
  expect(calls).toEqual([{
    model:'claude-sonnet-4-6',querySource:'hook_prompt',max_tokens:17,thinking:false,
    skipSystemPromptPrefix:true,dropCacheControlWhenCachingDisabled:true,effort:'low',signal:undefined,
    messages:[{role:'user',content:[marked('ab'),plain('NEW')]}],system:[marked('rules'),plain(' extra')],
  }])
})

const roots: string[] = [], runtimes: ReturnType<typeof createModsRuntime>[] = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root,{recursive:true,force:true})))
})

test('real author Worker normalizes blocks before frozen hooks and keeps opaque JavaScript values', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(),'mods-complete-blocks-')));roots.push(root)
  async function plugin(name: string, source: string) {
    const pluginRoot=join(root,name);await mkdir(pluginRoot)
    const entry=join(pluginRoot,'register.mjs');await writeFile(entry,source)
    return {name,storageId:name+'@test',pluginRoot,entrypoints:[entry]}
  }
  const owner = await plugin('block-owner', `export function register(on) {
    on('tool.call', async ($) => {
      const outputs=[];
      outputs.push(await $.model.complete({model:'haiku',prompt:[{text:'ab',cache:true},{text:'cd'}],system:[{text:'rules',cache:true}],extra:7}));
      outputs.push(await $.model.complete({model:'haiku',prompt:[],system:[]}));
      outputs.push(await $.model.complete({model:'haiku',prompt:'opaque',system:false}));
      outputs.push(await $.model.complete({model:'haiku',prompt:'malformed'}));
      try {await $.model.complete({model:'haiku',prompt:[{text:'x',extra:1}]});outputs.push('unexpected')}
      catch(error){outputs.push({name:error.name,message:error.message})}
      return {result:outputs};
    });
  }`)
  const observer = await plugin('block-observer', `export function register(on) {
    on('model.complete', ($,e,next) => {
      if(e.prompt==='opaque')return {value:'opaque-reply'};
      if(e.prompt==='malformed')return {value:{isAnswered:false,reason:'alien'}};
      return {value:{event:e,origin:next.origin.plugin,frozen:Object.isFrozen(e),blocksFrozen:Object.isFrozen(e.promptBlocks)}};
    });
  }`)
  const diagnostics: unknown[] = []
  const runtime=createModsRuntime({onDiagnostic:e=>diagnostics.push(e)});runtimes.push(runtime)
  await runtime.bind({cwd:root,sessionId:'blocks',surface:'terminal',isInteractive:true})
  await runtime.reconcile([owner,observer])
  expect(await runtime.dispatch('tool.call',{},async()=>({result:'core'}))).toEqual({result:[
    {event:{model:'haiku',prompt:'abcd',promptBlocks:[{text:'ab',cache:true},{text:'cd'}],system:'rules',systemBlocks:[{text:'rules',cache:true}],extra:7},origin:'block-owner',frozen:true,blocksFrozen:true},
    {event:{model:'haiku',prompt:'',promptBlocks:[],system:'',systemBlocks:[]},origin:'block-owner',frozen:true,blocksFrozen:true},
    'opaque-reply',{isAnswered:false,reason:'alien'},
    {name:'HooksError',message:'block-owner: model.complete: takes { model, prompt }, the prompt a string or a list of blocks, each { text } and at most `cache: true` (host check)'},
  ]})
  expect(diagnostics).toEqual([])
})
