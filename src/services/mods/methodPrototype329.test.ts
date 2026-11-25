import {afterEach, beforeEach, expect, test} from 'bun:test'
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createModEnvironmentHost} from './environment.js'
import {createModsRuntime} from './runtime.js'
import type {ModNext} from './types.js'

let root: string
let runtime: ReturnType<typeof createModsRuntime> | undefined
let host: ReturnType<typeof createModEnvironmentHost> | undefined
const keys = ['HOME','CLAUDE_CONFIG_DIR','ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN']
let saved: (string | undefined)[]
beforeEach(async () => {
  saved = keys.map(key => process.env[key])
  root = await realpath(await mkdtemp(join(tmpdir(),'mods-method-prototype-')))
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = join(root,'config')
  process.env.ANTHROPIC_API_KEY = 'test-method-prototype-placeholder'
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
})
afterEach(async () => {
  await runtime?.dispose()
  await host?.dispose()
  runtime = undefined
  host = undefined
  keys.forEach((key,index) => {if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]})
  await rm(root,{recursive:true,force:true})
})

// Official 2.1.329 (measured with -p): the timer handle and its cancel, next and next.is have a null prototype.
test('methods handed to a module have a null prototype like 2.1.329', async () => {
  const entry = join(root,'register.mjs')
  await writeFile(entry,`const P = v => v === null ? 'null' : v === Object.prototype ? 'Object' : v === Function.prototype ? 'Function' : 'other';
  export function register(on) {
    on('tool.call',async ($,e,next) => {
      const after = $.clock.after(100000,() => {});
      const every = $.clock.every(100000,() => {});
      const result = {
        after:P(Object.getPrototypeOf(after)), afterFrozen:Object.isFrozen(after), cancel:P(Object.getPrototypeOf(after.cancel)),
        cancelFrozen:Object.isFrozen(after.cancel), every:P(Object.getPrototypeOf(every)), everyCancel:P(Object.getPrototypeOf(every.cancel)),
      };
      after.cancel(); every.cancel();
      return {result};
    });
  }`)
  runtime = createModsRuntime({onDiagnostic:() => {}})
  await runtime.bind({cwd:root,surface:'terminal',isInteractive:true,sessionId:'method-prototype'})
  await runtime.reconcile([{name:'methods',storageId:'methods@test',pluginRoot:root,entrypoints:[entry]}])
  expect(await runtime.dispatch('tool.call',{tool:'Probe',args:{}},async () => {throw new Error('unhandled fixture tool')})).toEqual({result:{
    after:'null', afterFrozen:true, cancel:'null', cancelFrozen:false, every:'null', everyCancel:'null',
  }})
})

// next, next.to and next.is, and the registration on() returns, are handed to the module the same way.
test('next, its members and the registration have a null prototype like 2.1.329', async () => {
  host = createModEnvironmentHost()
  const source = `const P = v => v === null ? 'null' : v === Object.prototype ? 'Object' : v === Function.prototype ? 'Function' : 'other';
  let registration;
  export function register(on) {
    const handle = on('tool.call', ($, e, next) => ({
      next:P(Object.getPrototypeOf(next)), call:typeof next.call, to:P(Object.getPrototypeOf(next.to)), is:P(Object.getPrototypeOf(next.is)),
      ...registration,
    }));
    registration = {registration:P(Object.getPrototypeOf(handle)), catch:P(Object.getPrototypeOf(handle.catch))};
  }`
  const environment = await host.load({
    name:'methods', storageId:'methods@local', pluginRoot:'/methods', entrypoints:['/methods/register.js'],
    modules:[{path:'/methods/register.js', source}], links:[], events:['tool.call'], calls:[], nextTiers:[], options:{}, tier:'user', fingerprint:source,
  })
  const call = async () => ({})
  const next: ModNext = Object.assign(call, {
    to:call, is:(event: string) => event === 'tool.call', signal:new AbortController().signal, event:'tool.call',
    origin:{plugin:'engine', tier:'core' as const}, trace:[], budget:{ms:0, remainingMs:Infinity},
  })
  expect(await environment.invoke(environment.registrations[0]!.id, [{}, {}], next)).toEqual({
    next:'null', call:'undefined', to:'null', is:'null', registration:'null', catch:'null',
  })
})
