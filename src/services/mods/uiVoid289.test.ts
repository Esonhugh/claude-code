import {afterEach, beforeEach, expect, test} from 'bun:test'
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createModsRuntime, type ModDiagnostic} from './runtime.js'

const keys = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_CACHE_DIR'] as const
const previous = new Map<string, string | undefined>()
const runtimes: ReturnType<typeof createModsRuntime>[] = []
let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'owned-ui-void-289-')))
  for (const key of keys) previous.set(key, process.env[key])
  process.env.HOME = root
  process.env.USERPROFILE = root
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = join(root, 'cache')
})
afterEach(async () => {
  try { await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose())) }
  finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    previous.clear()
    await rm(root, {recursive: true, force: true})
  }
})

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not settle within 1000ms`)), 1000)
    })])
  } finally { clearTimeout(timer!) }
}

async function fixture(body: string, isNative = false) {
  const pluginRoot = join(root, 'void-author')
  await mkdir(pluginRoot)
  const entry = join(pluginRoot, 'register.ts')
  await writeFile(entry, `export function register(on) {on('command.run', async($,e) => {${body}})}`)
  const diagnostics: ModDiagnostic[] = []
  const logs: unknown[] = [], statuses: unknown[] = [], toasts: unknown[] = []
  const runtime = createModsRuntime({
    onDiagnostic: diagnostic => diagnostics.push(diagnostic),
    services: {
      uiLog: (...args) => {logs.push(args)},
      uiStatus: (...args) => {statuses.push(args)},
      uiToast: (...args) => {toasts.push(args)},
    },
  })
  runtimes.push(runtime)
  await runtime.bind({cwd: root, surface: 'terminal', isInteractive: true, sessionId: 'void-289'})
  await runtime.reconcile([{name: 'void-author', storageId: 'void-author@test', pluginRoot, entrypoints: [entry], isNative}])
  expect(diagnostics).toEqual([])
  const call = () => runtime.dispatch('command.run', {command: 'probe'}, async () => ({text: 'unhandled'}))
  return {runtime, call, diagnostics, logs, statuses, toasts}
}

for (const isNative of [false, true]) {
  test(`real Worker public notifications return void for host-native=${isNative}`, async () => {
    const {runtime, call, logs, statuses, toasts, diagnostics} = await fixture(`
      const log=$.ui.log('line'),status=$.ui.status('pinned'),toast=$.ui.toast('notice');
      return {text:JSON.stringify({log:typeof log,status:typeof status,toast:typeof toast,
        awaited:await log===undefined&&await status===undefined&&await toast===undefined})};`, isNative)
    expect(await bounded(call(), 'public receipt')).toEqual({text: JSON.stringify({log: 'undefined', status: 'undefined', toast: 'undefined', awaited: true})})
    await bounded(runtime.settle(), 'notification delivery')
    expect(logs).toEqual([['void-author', 'line', 'transcript']])
    expect(statuses).toEqual([['void-author', 'pinned']])
    expect(toasts).toEqual([['void-author', 'notice', 4000]])
    expect(diagnostics).toEqual([])
  })
}

test('real author realm converts text and reads only official notification option fields', async () => {
  const {runtime, call, diagnostics} = await fixture(`
    const order=[];
    $.ui.log(undefined);$.ui.log(null,null);$.ui.log(7,{to:null});$.ui.log(Symbol('line'),{to:'debug'});
    $.ui.log({toString(){order.push('log-text');return 'object-line'}},{get to(){order.push('log-to');return 'debug'},get ignored(){throw Error('unused')}});
    $.ui.status(undefined);$.ui.status(null);$.ui.status(8);$.ui.status(Symbol('status'));
    $.ui.toast({toString(){order.push('toast-text');return 'object-toast'}},{get timeoutMs(){order.push('toast-timeout');return 2500},get ignored(){throw Error('unused')}});
    $.ui.toast('default-timeout',{timeoutMs:'2500'});
    return {text:JSON.stringify(order)};`)
  const events: unknown[] = []
  for (const [id, event] of ['ui.log', 'ui.status', 'ui.toast'].entries()) runtime.registerHostHook({
    plugin: 'void-observer', tier: 'prepend', registration: {id, event, hasCatch: false},
    invoke: async (input, next) => {events.push([event, input, next.origin.plugin]); return next(input)},
  })
  expect(await bounded(call(), 'conversion receipt')).toEqual({text: JSON.stringify(['log-text', 'log-to', 'toast-text', 'toast-timeout', 'toast-timeout'])})
  await bounded(runtime.settle(), 'converted operation delivery')
  expect(events).toEqual([
    ['ui.log', {text: 'undefined', to: 'transcript'}, 'void-author'],
    ['ui.log', {text: 'null', to: 'transcript'}, 'void-author'],
    ['ui.log', {text: '7', to: 'transcript'}, 'void-author'],
    ['ui.log', {text: 'Symbol(line)', to: 'debug'}, 'void-author'],
    ['ui.log', {text: 'object-line', to: 'debug'}, 'void-author'],
    ['ui.status', {text: undefined}, 'void-author'],
    ['ui.status', {text: undefined}, 'void-author'],
    ['ui.status', {text: '8'}, 'void-author'],
    ['ui.status', {text: 'Symbol(status)'}, 'void-author'],
    ['ui.toast', {text: 'object-toast', timeoutMs: 2500}, 'void-author'],
    ['ui.toast', {text: 'default-timeout'}, 'void-author'],
  ])
  expect(diagnostics).toEqual([])
})

test('author conversion and option getter errors throw synchronously without dispatch', async () => {
  const {runtime, call, diagnostics, logs, statuses, toasts} = await fixture(`
    const caught=[];
    for(const run of [()=>$.ui.log({toString(){throw Error('log-text')}}),
      ()=>$.ui.status({toString(){throw Error('status-text')}}),
      ()=>$.ui.toast({toString(){throw Error('toast-text')}}),
      ()=>$.ui.log('line',{get to(){throw Error('log-to')}}),
      ()=>$.ui.toast('line',{get timeoutMs(){throw Error('toast-timeout')}}),
      ()=>$.ui.toast('line',null)]){
      try{run();caught.push('not-thrown')}catch(error){caught.push(error.name==='TypeError'?'TypeError':error.message)}
    }
    return {text:JSON.stringify(caught)};`)
  expect(await bounded(call(), 'synchronous error receipt')).toEqual({text: JSON.stringify(['log-text', 'status-text', 'toast-text', 'log-to', 'toast-timeout', 'TypeError'])})
  await bounded(runtime.settle(), 'rejected author input settlement')
  expect({logs, statuses, toasts, diagnostics}).toEqual({logs: [], statuses: [], toasts: [], diagnostics: []})
})

test('asynchronous notification denial logs owner and operation without rejecting await or retiring its hook', async () => {
  const {runtime, call, diagnostics, logs, statuses, toasts} = await fixture(`
    let caught=false;
    try{await $.ui.log('line');await $.ui.status('pinned');await $.ui.toast('notice')}catch{caught=true}
    return {text:JSON.stringify({caught})};`)
  const remove = ['ui.log', 'ui.status', 'ui.toast'].map((event, id) => runtime.registerHostHook({
    plugin: 'void-observer', tier: 'prepend', registration: {id, event, hasCatch: false},
    invoke: async () => ({deny: `blocked-${event}`}),
  }))
  expect(await bounded(call(), 'denied notifications receipt')).toEqual({text: JSON.stringify({caught: false})})
  await bounded(runtime.settle(), 'denial warnings')
  expect(diagnostics).toHaveLength(3)
  for (const event of ['ui.log', 'ui.status', 'ui.toast']) expect(diagnostics).toContainEqual(expect.objectContaining({
    plugin: 'void-author', stage: 'async', message: `$.${event} dropped: blocked-${event}`,
  }))
  expect({logs, statuses, toasts}).toEqual({logs: [], statuses: [], toasts: []})
  for (const dispose of remove) dispose()
  expect(await bounded(call(), 'same author hook after denial')).toEqual({text: JSON.stringify({caught: false})})
  await bounded(runtime.settle(), 'recovered notification delivery')
  expect(logs).toEqual([['void-author', 'line', 'transcript']])
  expect(statuses).toEqual([['void-author', 'pinned']])
  expect(toasts).toEqual([['void-author', 'notice', 4000]])
  expect(diagnostics).toHaveLength(3)
})

test('held notification middleware keeps original owner after the author command returns', async () => {
  const {runtime, call, diagnostics, logs} = await fixture(`const result=$.ui.log('held');return {text:typeof result}`)
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let completed = false
  let origin: string | undefined
  runtime.registerHostHook({
    plugin: 'void-observer', tier: 'prepend', registration: {id: 1, event: 'ui.log', hasCatch: false},
    invoke: async (input, next) => {
    origin = next.origin.plugin
    started.resolve()
    await release.promise
    const receipt = await next({...input, text: `${input.text}:rewritten`, to: 'debug'})
    completed = true
    return receipt
    },
  })
  const work = call()
  try {
    await bounded(started.promise, 'middleware start')
    expect(await bounded(work, 'author independent return')).toEqual({text: 'undefined'})
    expect(completed).toBe(false)
    expect(origin).toBe('void-author')
    expect(logs).toEqual([])
  } finally {
    release.resolve()
    await bounded(work.catch(() => undefined), 'author cleanup')
  }
  await bounded(runtime.settle(), 'held notification delivery')
  expect(completed).toBe(true)
  expect(logs).toEqual([['void-author', 'held:rewritten', 'debug']])
  expect(diagnostics).toEqual([])
})

test('invalid original log sink is rejected before middleware can rewrite it', async () => {
  const {runtime, call, diagnostics, logs} = await fixture(`
    const result=$.ui.log('bad-sink',{to:'other'});return {text:typeof result};`)
  const seen: unknown[] = []
  runtime.registerHostHook({
    plugin: 'void-observer', tier: 'prepend', registration: {id: 1, event: 'ui.log', hasCatch: false},
    invoke: async (input, next) => {seen.push(input); return next({...input, to: 'debug'})},
  })
  expect(await bounded(call(), 'invalid sink author receipt')).toEqual({text: 'undefined'})
  await bounded(runtime.settle(), 'initial sink validation')
  expect(seen).toEqual([])
  expect(logs).toEqual([])
  expect(diagnostics).toEqual([expect.objectContaining({
    plugin: 'void-author', stage: 'async', message: '$.ui.log dropped: ui.log to must be transcript or debug',
  })])
})
