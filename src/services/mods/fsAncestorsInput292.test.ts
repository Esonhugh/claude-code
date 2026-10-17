import {afterEach, beforeEach, expect, test} from 'bun:test'
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createModsRuntime} from './runtime.js'

let root: string
let runtime: ReturnType<typeof createModsRuntime> | undefined
const keys = ['HOME','CLAUDE_CONFIG_DIR','ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN']
let saved: (string | undefined)[]
const diagnostics: unknown[] = []
beforeEach(async () => {
  saved = keys.map(key => process.env[key])
  root = await realpath(await mkdtemp(join(tmpdir(),'mods-ancestor-input-')))
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = join(root,'config')
  process.env.ANTHROPIC_API_KEY = 'test-ancestor-input-placeholder'
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  diagnostics.length = 0
})
afterEach(async () => {
  await runtime?.dispose(); runtime = undefined
  keys.forEach((key,index) => {if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]})
  await rm(root,{recursive:true,force:true})
})
async function load(source: string, services = {}) {
  const entry = join(root,'register.mjs')
  await writeFile(entry,source)
  runtime = createModsRuntime({services,onDiagnostic:event => diagnostics.push(event)})
  await runtime.bind({cwd:root,surface:'terminal',isInteractive:true,sessionId:'ancestor-input'})
  await runtime.reconcile([{name:'ancestors',storageId:'ancestors@test',pluginRoot:root,entrypoints:[entry]}])
}
function run() {return runtime!.dispatch('tool.call',{tool:'Ancestors',args:{}},async () => ({result:'unexpected core'}))}

test('fs.ancestors raises only of before entry matchers and preserves absent of and relative below', async () => {
  await load(`const seen=[];export function register(on) {
    on('tool.call',async $ => {
      const results=[];
      for(const request of [{names:['ABSENT_ANCESTOR.md']},{names:['ABSENT_ANCESTOR.md'],of:'./nested/../probe.txt',below:'./nested'},{names:['ABSENT_ANCESTOR.md'],of:'.',below:'.'},{names:['ABSENT_ANCESTOR.md'],of:'~/probe.txt',below:'~'}]) results.push(await $.fs.ancestors(request));
      return {result:{seen,results}};
    });
    on('fs.ancestors',async($,e,next) => {seen.push({input:e,origin:next.origin});return next(e)});
  }`)
  // Official 2.1.292 native: only the optional of field is raised; below is left as supplied.
  expect(await run()).toEqual({result:{seen:[
    {input:{names:['ABSENT_ANCESTOR.md']},origin:{plugin:'ancestors',tier:'user'}},
    {input:{names:['ABSENT_ANCESTOR.md'],of:join(root,'probe.txt'),below:'./nested'},origin:{plugin:'ancestors',tier:'user'}},
    {input:{names:['ABSENT_ANCESTOR.md'],of:root,below:'.'},origin:{plugin:'ancestors',tier:'user'}},
    {input:{names:['ABSENT_ANCESTOR.md'],of:join(root,'~/probe.txt'),below:'~'},origin:{plugin:'ancestors',tier:'user'}},
  ],results:[[],[],[],[]]}})
  expect(diagnostics).toEqual([])
})

test('fs.ancestors leaves a relative next of unchanged before matching without changing the caller input', async () => {
  // Official 2.1.292 native: next() forwards relative of literally to later matchers.
  const first=join(root,'probe.txt'), second='./nested/../next.txt'
  await load(`const seen=[];export function register(on) {
    on('tool.call',async $ => ({result:{value:await $.fs.ancestors({names:['ABSENT_ANCESTOR.md'],of:'probe.txt',below:'.'}),seen}}));
    on('fs.ancestors',{of:${JSON.stringify(first)}},async($,e,next) => {
      seen.push({stage:'entry',input:e});
      const value=await next({...e,of:'./nested/../next.txt',below:'./nested'});
      seen.push({stage:'after',input:e});return value;
    });
    on('fs.ancestors',{of:${JSON.stringify(second)}},async($,e,next) => {seen.push({stage:'below',input:e});return next(e)});
  }`)
  expect(await run()).toEqual({result:{value:[],seen:[
    {stage:'entry',input:{names:['ABSENT_ANCESTOR.md'],of:first,below:'.'}},
    {stage:'below',input:{names:['ABSENT_ANCESTOR.md'],of:second,below:'./nested'}},
    {stage:'after',input:{names:['ABSENT_ANCESTOR.md'],of:first,below:'.'}},
  ]}})
  expect(diagnostics).toEqual([])
})

test('fs.ancestors preserves a relative next of after the host cwd changes', async () => {
  let cwd=root
  await load(`const seen=[];export function register(on) {
    on('tool.call',async $ => ({result:{value:await $.fs.ancestors({names:['ABSENT_ANCESTOR.md'],of:'probe.txt',below:'.'}),seen}}));
    on('fs.ancestors',{of:${JSON.stringify(join(root,'probe.txt'))}},async($,e,next) => {
      await $.env.get('CHANGE_CWD');return next({...e,of:'next.txt'});
    });
    on('fs.ancestors',{of:'next.txt'},async($,e,next) => {seen.push(e);return next(e)});
  }`,{cwd:() => cwd})
  runtime!.registerHostCallback({tier:'core',registration:{id:999,event:'env.get',matcher:{name:'CHANGE_CWD'},hasCatch:false}},async () => {cwd=join(root,'changed');return {value:'changed'}})
  expect(await run()).toEqual({result:{value:[],seen:[{names:['ABSENT_ANCESTOR.md'],of:'next.txt',below:'.'}]}})
  expect(cwd).toBe(join(root,'changed'))
  expect(diagnostics).toEqual([])
})
