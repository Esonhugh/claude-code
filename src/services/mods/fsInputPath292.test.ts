import {afterEach, beforeEach, expect, test} from 'bun:test'
import {mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile} from 'node:fs/promises'
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
  root = await realpath(await mkdtemp(join(tmpdir(),'mods-fs-input-')))
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = join(root,'config')
  process.env.ANTHROPIC_API_KEY = 'test-fs-input-placeholder'
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  diagnostics.length = 0
  await writeFile(join(root,'file.txt'),'original')
  await writeFile(join(root,'other.txt'),'rewritten')
  for (const path of ['dir','otherdir','nested','~']) await mkdir(join(root,path))
  await writeFile(join(root,'~/file.txt'),'literal home')
  await symlink('file.txt',join(root,'alias.txt'))
})
afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
  keys.forEach((key,index) => {if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]})
  await rm(root,{recursive:true,force:true})
})
async function load(source: string, services = {}) {
  const entry = join(root,'register.mjs')
  await writeFile(entry,source)
  runtime = createModsRuntime({services,onDiagnostic:event => diagnostics.push(event)})
  await runtime.bind({cwd:root,surface:'terminal',isInteractive:true,sessionId:'fs-input'})
  await runtime.reconcile([{name:'paths',storageId:'paths@test',pluginRoot:root,entrypoints:[entry]}])
}
function run() {return runtime!.dispatch('tool.call',{tool:'Paths',args:{}},async () => {throw new Error('unhandled fixture tool')})}

for (const method of ['read','stat','exists','list','write'] as const) test(`fs.${method} raises entry and next paths before matching without mutating the calling frame`, async () => {
  const first = join(root,method === 'list' ? 'dir' : 'file.txt')
  const second = join(root,method === 'list' ? 'otherdir' : 'other.txt')
  const options = method === 'read' ? {as:'text'} : method === 'stat' ? {resolve:false} : method === 'write' ? {text:'written'} : {}
  const tail = method === 'write' ? ",'written'" : ''
  await load(`const seen=[]; export function register(on) {
    on('tool.call',async $ => {const value=await $.fs.${method}('./${method === 'list' ? 'dir' : 'file.txt'}'${tail});return {result:{value:value===undefined?'void':value,seen}}});
    on('fs.${method}',{path:${JSON.stringify(first)}},async($,e,next) => {
      seen.push({stage:'entry',input:e,origin:next.origin});
      const result=await next({...e,path:'./nested/../${method === 'list' ? 'otherdir' : 'other.txt'}'});
      seen.push({stage:'after',input:e});return result;
    });
    on('fs.${method}',{path:${JSON.stringify(second)}},async($,e,next) => {seen.push({stage:'below',input:e,origin:next.origin});return next(e)});
  }`)
  const info = await stat(second)
  const expected = method === 'read' ? 'rewritten' : method === 'exists' ? true : method === 'list' ? [] : method === 'write' ? 'void' :
    {kind:'file',size:9,mtimeMs:info.mtimeMs,isLink:false}
  // Official 2.1.292 native: both entry and next() are raised before the next matcher.
  expect(await run()).toEqual({result:{value:expected,seen:[
    {stage:'entry',input:{path:first,...options},origin:{plugin:'paths',tier:'user'}},
    {stage:'below',input:{path:second,...options},origin:{plugin:'paths',tier:'user'}},
    {stage:'after',input:{path:first,...options}},
  ]}})
  if (method === 'write') {
    expect(await readFile(first,'utf8')).toBe('original')
    expect(await readFile(second,'utf8')).toBe('written')
  }
  expect(diagnostics).toEqual([])
})

test('lexical paths preserve symlink spelling and literal tilde against the current host cwd', async () => {
  let cwd = root
  await load(`const seen=[]; export function register(on) {
    on('tool.call',async $ => ({result:{values:[await $.fs.read('./dir/../file.txt'),await $.fs.read('alias.txt'),await $.fs.read('~/file.txt')],seen}}));
    on('fs.read',async($,e,next) => {seen.push(e);return next(e)});
  }`,{cwd:() => cwd})
  expect(await run()).toEqual({result:{values:['original','original','literal home'],seen:[
    {path:join(root,'file.txt'),as:'text'},{path:join(root,'alias.txt'),as:'text'},{path:join(root,'~/file.txt'),as:'text'},
  ]}})
  const next = join(root,'next')
  await mkdir(join(next,'dir'),{recursive:true});await mkdir(join(next,'~'))
  await writeFile(join(next,'file.txt'),'next');await symlink('file.txt',join(next,'alias.txt'));await writeFile(join(next,'~/file.txt'),'next home')
  cwd = next
  const result = await run() as {result:{values:unknown[];seen:unknown[]}}
  expect(result.result.values).toEqual(['next','next','next home'])
  expect(result.result.seen.slice(3)).toEqual([{path:join(next,'file.txt'),as:'text'},{path:join(next,'alias.txt'),as:'text'},{path:join(next,'~/file.txt'),as:'text'}])
  expect(diagnostics).toEqual([])
})

test('invalid paths fail before middleware and missing files carry the raised path in the official error', async () => {
  await load(`let calls=0;export function register(on) {
    on('tool.call',async $ => {
      const errors=[];
      for (const path of ['',42,null,'missing.txt']) {
        try {await $.fs.read(path)} catch(error) {errors.push({name:error.name,message:error.message})}
      }
      return {result:{calls,errors}};
    });
    on('fs.read',async($,e,next) => {calls++;return next(e)});
  }`)
  expect(await run()).toEqual({result:{calls:1,errors:[
    ...Array.from({length:3},() => ({name:'HooksError',message:'paths: fs.read: takes a path (host check)'})),
    {name:'HooksError',message:`paths: $.fs.read(${join(root,'missing.txt')}) failed: ENOENT`},
  ]}})
  expect(diagnostics).toEqual([])
})
