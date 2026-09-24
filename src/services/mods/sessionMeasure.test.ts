import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsSession } from './session.js'
import { captureModSessionUsage, type ModSessionUsage } from './sessionUsage.js'
import { createAssistantMessage } from '../../utils/messages.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import * as limits from '../claudeAiLimits.js'
import * as cost from '../../cost-tracker.js'
import * as auth from '../../utils/auth.js'
import * as config from '../../utils/config.js'
import * as rateMocking from '../rateLimitMocking.js'

const cleanups: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const binding = {cwd:'/tmp',sessionId:'measure-first',surface:null,isInteractive:false} as const
const inspect = (host: ReturnType<typeof createModsSession>) => host.runtime!.dispatch('tool.call', {tool:'Inspect',tool_use_id:'inspect'}, async () => ({result:null})) as Promise<{result:any}>

async function fixture(source: string, captureUsage: () => ReturnType<typeof captureModSessionUsage>) {
  const root = await mkdtemp(join(tmpdir(), 'mods-measure-'))
  cleanups.push(() => rm(root, {recursive:true,force:true}))
  await writeFile(join(root, 'register.ts'), source)
  const diagnostics: unknown[] = []
  const host = createModsSession({
    isTrusted:true,
    getSettings:() => ({userSettings:null,flagSettings:null,policySettings:null,hookPolicy:{managedOnly:false,allDisabled:false}}),
    loadPlugins:async () => [{name:'measure',manifest:{name:'measure'},path:root,source:'measure@inline',repository:'measure@inline',enabled:true,
      hookModules:[{configPath:join(root,'hooks.json'),paths:['./register.ts']}]}],
    onDiagnostic:event => diagnostics.push(event),
  })
  cleanups.push(() => host.dispose())
  await host.bind(binding, undefined, {captureUsage})
  return {host,diagnostics}
}

const recorder = `let events=[]; export function register(on) {
  on('session.start', async ($,e,next) => { await $.clock.sleep(5); events.push('start'); return next(e); });
  on('session.measure', async ($,e,next) => { events.push({input:e,usage:await $.session.usage(),result:await next(e)}); return {changed:['cost']}; });
  on('session.end', ($,e,next) => { events.push('end'); return next(e); });
  on('tool.call', () => ({result:events}));
}`

async function waitFor(predicate: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 1000
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setImmediate(resolve))
  }
}

test('live rate headers push measurements below warning thresholds and disposal unsubscribes', async () => {
  const saved = structuredClone(limits.currentLimits)
  const subscriber = spyOn(auth,'isClaudeAISubscriber').mockReturnValue(true)
  const processHeaders = spyOn(rateMocking,'processRateLimitHeaders').mockImplementation(value => value)
  const globalConfig = spyOn(config,'getGlobalConfig').mockReturnValue({cachedExtraUsageDisabledReason:null} as never)
  const savedRaw = structuredClone(limits.getRawUtilization())
  cleanups.push(() => {
    const headers = new Headers()
    for (const [kind,reading] of Object.entries(savedRaw)) {
      const prefix = `anthropic-ratelimit-unified-${kind==='five_hour'?'5h':'7d'}`
      headers.set(`${prefix}-utilization`,String(reading.utilization))
      headers.set(`${prefix}-reset`,String(reading.resets_at))
    }
    limits.extractQuotaStatusFromHeaders(headers)
    limits.emitStatusChange(saved)
    subscriber.mockRestore();processHeaders.mockRestore();globalConfig.mockRestore()
  })
  const context = {messages:[],getAppState:() => getDefaultAppState(),options:{mainLoopModel:'claude-sonnet-4-6',tools:[],agentDefinitions:{activeAgents:[],allAgents:[],allowedAgentTypes:undefined}}}
  let captures=0
  const {host,diagnostics} = await fixture(recorder, () => {captures++;return captureModSessionUsage(context)})
  expect(diagnostics).toEqual([])
  limits.extractQuotaStatusFromHeaders(new Headers({
    'anthropic-ratelimit-unified-status':'allowed',
    'anthropic-ratelimit-unified-5h-utilization':'0.12',
    'anthropic-ratelimit-unified-5h-reset':'2000000000',
  }))
  await waitFor(async () => (await inspect(host)).result.some((event:any) => typeof event === 'object'), 'rate update never dispatched measure')
  const event = (await inspect(host)).result.find((value:any) => typeof value === 'object')
  expect(event.input.rateLimits).toEqual([{kind:'five_hour',percentUsed:12,resetsAt:'2033-05-18T03:33:20.000Z'}])
  limits.emitStatusChange({...limits.currentLimits,status:'rejected'})
  await waitFor(async () => (await inspect(host)).result.filter((event:any) => typeof event === 'object').length===2,'status update never dispatched measure')
  expect((await inspect(host)).result.at(-1).input.changed).toEqual(['rateLimits'])
  await host.dispose()
  const before=captures
  limits.emitStatusChange({...limits.currentLimits,status:'rejected'})
  await Promise.resolve()
  expect(captures).toBe(before)
})

test('session.measure coalesces bursts, pins readonly input and cancels before end', async () => {
  const usage: ModSessionUsage = {context:{window:200000},rateLimits:[],cost:{usd:0}}
  let captures = 0
  const {host,diagnostics} = await fixture(`let events=[],release; export function register(on) {
    on('session.start', ($,e,next) => next(e));
    on('session.measure', async ($,e,next) => {
      events.push(['enter',e.cost.usd,Object.isFrozen(e),Object.isFrozen(e.context)]);
      if(e.cost.usd===0) await new Promise(resolve => {release=resolve});
      const result=await next({...e,context:{window:1},changed:[]});
      events.push(['exit',e.cost.usd,result.changed]);
      return {changed:[]};
    });
    on('session.measure', ($,e,next) => {events.push(['inner',e.context.window]);return next(e)});
    on('session.end', ($,e,next) => {events.push(['end']);return next(e)});
    on('tool.call', ($,e) => {if(e.tool==='Release')release();return {result:events}});
  }`, () => {captures++;const value=structuredClone(usage);return async () => value})
  expect(diagnostics).toEqual([])
  const first = host.runtime!.measure()
  // The read boundary tells us the Worker frame has been entered without relying on a timer.
  await waitFor(async () => (await inspect(host)).result.length > 0, 'measure hook did not start')
  usage.cost!.usd = 1
  const second = host.runtime!.measure()
  usage.cost!.usd = 2
  const third = host.runtime!.measure()
  await host.runtime!.dispatch('tool.call',{tool:'Release',tool_use_id:'release'},async () => ({result:null}))
  await Promise.all([first,second,third])
  expect(captures).toBe(2)
  expect((await inspect(host)).result).toEqual([
    ['enter',0,true,true],['inner',200000],['exit',0,['context','cost']],
    ['enter',2,true,true],['inner',200000],['exit',2,['cost']],
  ])
  await host.runtime!.endSession('other')
  await host.runtime!.measure()
  expect(captures).toBe(2)
  await host.bind({...binding,sessionId:'measure-second'})
  await host.runtime!.measure()
  expect((await inspect(host)).result.at(-1)).toEqual(['exit',2,['context','cost']])
  expect(diagnostics).toEqual([])
})

test.each(['end','dispose'] as const)('session.measure cancellation on %s interrupts active hooks and drops pending samples', async action => {
  const usage: ModSessionUsage = {context:{window:200000},rateLimits:[],cost:{usd:0}}
  let captures=0
  const {host,diagnostics} = await fixture(`let events=[]; export function register(on) {
    on('session.measure', async ($,e,next) => {
      events.push('enter');
      await new Promise(resolve => next.signal.addEventListener('abort', () => {events.push('abort');resolve()}, {once:true}));
      return {changed:e.changed};
    });
    on('session.end', ($,e,next) => {events.push('end');return next(e)});
    on('tool.call', () => ({result:events}));
  }`, () => {captures++;return async () => structuredClone(usage)})
  const running=host.runtime!.measure()
  await waitFor(async () => (await inspect(host)).result.includes('enter'),'measure hook never started')
  const pending=host.runtime!.measure()
  if(action==='end') {
    await host.runtime!.endSession('other')
    expect((await inspect(host)).result).toEqual(['enter','abort','end'])
  } else await host.dispose()
  await Promise.all([running,pending])
  expect(captures).toBe(1)
  expect(diagnostics).toEqual([])
})

test('session.measure end cancels a stalled usage read without delaying the end budget', async () => {
  let entered!: () => void
  const started=new Promise<void>(resolve => {entered=resolve})
  let signal: AbortSignal | undefined
  const {host,diagnostics}=await fixture(recorder, () => async (_args,activeSignal) => {
    signal=activeSignal;entered();return new Promise<ModSessionUsage>(() => {})
  })
  const running=host.runtime!.measure()
  await started
  await host.runtime!.endSession('other',100)
  await running
  expect(signal?.aborted).toBe(true)
  expect((await inspect(host)).result).toEqual(['start','end'])
  expect(diagnostics).toEqual([])
})

test('session.measure compares against last raised reading, not each sample', async () => {
  let usage: ModSessionUsage = {context:{window:200000},rateLimits:[]}
  const {host,diagnostics} = await fixture(recorder, () => async () => structuredClone(usage))
  expect(diagnostics).toEqual([])
  await host.runtime!.measure()
  expect((await inspect(host)).result[1].input.changed).toEqual(['context'])
  usage = {...usage,rateLimits:[{kind:'five_hour',percentUsed:7.1}]}
  await host.runtime!.measure()
  usage.rateLimits[0]!.percentUsed = 7.9
  await host.runtime!.measure()
  expect((await inspect(host)).result).toHaveLength(3)
  usage.rateLimits[0]!.percentUsed = 8
  await host.runtime!.measure()
  expect((await inspect(host)).result.at(-1).input.changed).toEqual(['rateLimits'])
  usage = {...usage,cost:{usd:1}}
  await host.runtime!.measure()
  expect((await inspect(host)).result.at(-1).input.changed).toEqual(['cost'])
  usage.cost!.usd = 0.5
  usage.context.window = 1000000
  usage.rateLimits[0]!.resetsAt = '2033-05-18T03:33:20.000Z'
  await host.runtime!.measure()
  expect((await inspect(host)).result).toHaveLength(5)
  usage = {...usage,context:{window:200000,tokens:1,percent:0},rateLimits:[]}
  await host.runtime!.measure()
  expect((await inspect(host)).result.at(-1).input.changed).toEqual(['context','rateLimits'])
  expect(diagnostics).toEqual([])
})

test('session.measure loads into the real host/Worker and observes captured usage after start', async () => {
  const message = createAssistantMessage({content:'answer'})
  Object.assign(message.message, {model:'claude-sonnet-4-6',usage:{input_tokens:2000,cache_creation_input_tokens:1000,cache_read_input_tokens:7000,output_tokens:9000}})
  const rate = spyOn(limits,'getRawUtilization').mockReturnValue({five_hour:{utilization:0.234567,resets_at:123}})
  const ledger = spyOn(cost,'getTotalCost').mockReturnValue(1.25)
  cleanups.push(() => rate.mockRestore(), () => ledger.mockRestore())
  const context = {messages:[message],getAppState:() => getDefaultAppState(),options:{mainLoopModel:'claude-sonnet-4-6',tools:[],agentDefinitions:{activeAgents:[],allAgents:[],allowedAgentTypes:undefined}}}
  const {host,diagnostics} = await fixture(recorder, () => captureModSessionUsage(context))
  expect(diagnostics).toEqual([])
  await host.runtime!.measure()
  const usage = {context:{window:200000,tokens:10000,percent:5},rateLimits:[{kind:'five_hour',percentUsed:23.5,resetsAt:'1970-01-01T00:02:03.000Z'}],cost:{usd:1.25}}
  expect((await inspect(host)).result).toEqual(['start',{input:{...usage,changed:['context','rateLimits','cost']},usage,result:{changed:['context','rateLimits','cost']}}])
  await host.runtime!.measure()
  expect((await inspect(host)).result).toHaveLength(2)
  await host.runtime!.endSession('other')
  await host.runtime!.measure()
  expect((await inspect(host)).result.at(-1)).toBe('end')
  expect(diagnostics).toEqual([])
})
