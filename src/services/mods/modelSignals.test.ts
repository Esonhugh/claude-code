import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime } from './runtime.js'
import cases from './fixtures/modelSignals292.json'

let root: string
const runtimes: ReturnType<typeof createModsRuntime>[] = []
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'mods-model-signals-')) })
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
  await rm(root, { recursive: true, force: true })
})
const usage = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }

// Author expressions and receipts observed in official 2.1.292, through command.run.
// These tests run the same expressions through an adjacent tool.call capability.
test.each(cases)('model.complete author options and reply contract: $action', async ({ action, block, expected, requests }) => {
  let calls = 0, hooks = 0
  const runtime = createModsRuntime({ services: { modelComplete: async request => {
    calls++
    return { isAnswered: true, text: request.prompt.endsWith('-first') ? 'first' : request.prompt.endsWith('-second') ? 'second' : 'ok', usage: { ...usage } }
  } } })
  runtimes.push(runtime)
  await runtime.bind({ cwd: root, sessionId: 'test', surface: 'terminal', isInteractive: true })
  const entry = join(root, 'register.ts')
  await writeFile(entry, `export function register(on) {
    on('tool.call', async $ => {
      const action=${JSON.stringify(action)},stopped=new AbortController(),live=new AbortController();stopped.abort('private-reason');
      let signalReads=0,inputReads=0,attached=0,detached=0,timerFired=false,replyStillPending,result;
      const watched={get aborted(){return live.signal.aborted},get reason(){return live.signal.reason},addEventListener(...args){attached++;live.signal.addEventListener(...args)},removeEventListener(...args){detached++;live.signal.removeEventListener(...args)}};
      try { ${block} } catch(error) { result={caught:true,kind:error.name,message:error.message} }
      const show=value=>Array.isArray(value)?value.map(show):value&&typeof value==='object'&&value.usage?{...value,usage:Object.values(value.usage)}:value;
      return {result:{action,result:result===undefined?{isUndefined:true}:show(result),frozen:Object.isFrozen(result),usageFrozen:Boolean(result&&typeof result==='object'&&result.usage&&Object.isFrozen(result.usage)),...(Array.isArray(result)?{innerFrozen:result.map(v=>({frozen:Object.isFrozen(v),usageFrozen:Object.isFrozen(v.usage)}))}:{}),signalReads,inputReads,attached,detached,timerFired}};
    });
  }`)
  const release = runtime.registerHostHook({ plugin: 'observer', tier: 'user', registration: { id: 1, event: 'model.complete', hasCatch: false }, invoke: async (input, next) => {
    hooks++
    expect(input).not.toHaveProperty('signal')
    return next(input)
  } })
  try {
    await runtime.reconcile([{ name: 'signal-owner', storageId: 'signal-owner@test', pluginRoot: root, entrypoints: [entry] }])
    expect(await runtime.dispatch('tool.call', {}, async () => ({ result: 'core' }))).toEqual({ result: expected })
    expect(calls).toBe(requests)
    expect(hooks).toBe(requests)
  } finally { release() }
})
