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
  root = await realpath(await mkdtemp(join(tmpdir(),'mods-clock-caller-')))
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = join(root,'config')
  process.env.ANTHROPIC_API_KEY = 'test-clock-caller-placeholder'
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  diagnostics.length = 0
  await writeFile(join(root,'callback.txt'),'callback text')
})
afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
  keys.forEach((key,index) => {if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]})
  await rm(root,{recursive:true,force:true})
})
async function load(source: string, clockGate?: Promise<unknown>) {
  const entry = join(root,'register.mjs')
  await writeFile(entry,source)
  runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event)})
  if (clockGate) runtime.registerHostCallback({tier:'prepend',registration:{id:999,event:'clock.after',hasCatch:false}},
    async () => {await clockGate; return {value:undefined}})
  await runtime.bind({cwd:root,surface:'terminal',isInteractive:true,sessionId:'clock-caller'})
  await runtime.reconcile([{name:'callback',storageId:'callback@test',pluginRoot:root,entrypoints:[entry]}])
}
function fire(tool: string) {
  return runtime!.dispatch('tool.call',{tool,args:{}},async () => {throw new Error('unhandled fixture tool')})
}

test('live clock callback excludes its original fs.read registration while preserving siblings', async () => {
  await load(`let entries=0; export function register(on) {
    on('tool.call',async $ => ({result:{text:await $.fs.read('callback.txt'),entries}}));
    on('fs.read',async($,e,next) => {
      entries++;
      if (entries===1) return {value:await new Promise(resolve => $.clock.after(0,async () => resolve(await $.fs.read('callback.txt'))))};
      return next(e);
    });
    on('fs.read',{},async($,e,next) => ({value:(await next(e)).value+':sibling'}));
  }`)
  // Official 2.1.292 native: nested read runs the sibling once, original entries stays 1.
  expect(await fire('Read')).toEqual({result:{text:'callback text:sibling',entries:1}})
  expect(diagnostics).toEqual([])
})

for (const startedBefore of [false,true]) test(`clock callback excludes the owner after its scheduling receipt settles (already started=${startedBefore})`, async () => {
  const gate = Promise.withResolvers<void>()
  await load(`let release,done; export function register(on) {
    on('tool.call',{tool:'Start'},async $ => {
      const released=new Promise(resolve => release=resolve);
      let finish; done=new Promise(resolve => finish=resolve);
      const started=new Promise(start => $.clock.after(0,async () => {
        start(); await released; finish(await $.fs.read('callback.txt'));
      }));
      ${startedBefore ? 'await started;' : ''}
      return {result:'started'};
    });
    on('tool.call',{tool:'Result'},async () => {release(); return {result:await done}});
    on('fs.read',async($,e,next) => ({value:(await next(e)).value+':owner'}));
  }`,startedBefore ? undefined : gate.promise)
  expect(await fire('Start')).toEqual({result:'started'})
  gate.resolve()
  // Official 2.1.292 native: both timing orders exclude all middleware from the scheduling plugin.
  expect(await fire('Result')).toEqual({result:'callback text'})
  expect(diagnostics).toEqual([])
})

test('live clock callback preserves registration exclusion for a real process stream', async () => {
  await load(`let entries=0,siblings=0; export function register(on) {
    on('tool.call',async $ => {
      const flow=$.process.spawn({argv:['/usr/bin/printf','timer output']});
      const chunks=[]; for await (const chunk of flow) chunks.push(chunk);
      return {result:{chunks,receipt:await flow.result,entries,siblings}};
    });
    on('process.spawn',async function*($,e,next) {
      entries++;
      if (entries===1) {
        const output=await new Promise(resolve => $.clock.after(0,async () => {
          const flow=$.process.spawn(e); const chunks=[];
          for await (const chunk of flow) chunks.push(chunk);
          resolve({chunks,receipt:await flow.result});
        }));
        for (const chunk of output.chunks) yield chunk;
        return {value:output.receipt};
      }
      return yield* next(e);
    });
    on('process.spawn',{},async function*($,e,next) {siblings++; return yield* next(e)});
  }`)
  expect(await fire('Spawn')).toEqual({result:{chunks:[{stream:'stdout',text:'timer output'}],
    receipt:{code:0,signal:null},entries:1,siblings:1}})
  expect(diagnostics).toEqual([])
})
