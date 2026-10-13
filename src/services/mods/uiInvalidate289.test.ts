import {afterEach, beforeEach, expect, test} from 'bun:test'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createModsRuntime, type ModDiagnostic, type ModPluginInput} from './runtime.js'
import type {ModRenderSite} from './ui.js'

const events = ['ui.render', 'prompt.section', 'prompt.context', 'prompt.attachment', 'tool.describe', 'command.describe', 'config.describe'] as const
const environmentKeys = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_CACHE_DIR'] as const
const previousEnvironment = new Map<string, string | undefined>()
const runtimes: ReturnType<typeof createModsRuntime>[] = []
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'owned-ui-invalidate-289-'))
  for (const key of environmentKeys) previousEnvironment.set(key, process.env[key])
  process.env.HOME = root
  process.env.USERPROFILE = root
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = join(root, 'cache')
})

afterEach(async () => {
  try { await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose())) }
  finally {
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    previousEnvironment.clear()
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

async function plugin(name: string, source: string): Promise<ModPluginInput> {
  const pluginRoot = join(root, name)
  await mkdir(pluginRoot, {recursive: true})
  const entry = join(pluginRoot, 'register.ts')
  await writeFile(entry, source)
  return {name, storageId: `${name}@test`, pluginRoot, entrypoints: [entry]}
}

const authorSource = `let revision=0;
export function register(on) {
  on('command.run',async($,e)=>{
    if(e.command==='mutate'){revision++;return {text:'mutated'}}
    revision++;
    const returned=$.ui.invalidate(e.args || 'ui.render');
    const settled=await returned;
    await $.ui.status('author-receipt');
    return {text:JSON.stringify({immediateUndefined:returned===undefined,awaitedUndefined:settled===undefined})};
  });
  on('ui.render',{component:'AbovePrompt'},($,e)=>$.ui.resolve(e).Text({children:'revision:'+revision}));
}`

const observerSource = `export function register(on) {
  on('ui.invalidate',async($,e,next)=>{
    const result=await next(e);
    await $.ui.status(JSON.stringify({event:e.event,undefinedValue:result.value===undefined,origin:next.origin.plugin}));
    return result;
  });
}`

async function fixture(observer?: string) {
  const diagnostics: ModDiagnostic[] = []
  const statuses: [string, string | undefined][] = []
  const receipt = Promise.withResolvers<void>()
  const warning = Promise.withResolvers<ModDiagnostic>()
  const runtime = createModsRuntime({
    onDiagnostic: event => {
      diagnostics.push(event)
      if (event.plugin === 'invalidate-author' && (event.stage === 'ui.invalidate' || event.message.includes('ui.invalidate'))) warning.resolve(event)
    },
    services: {
      uiStatus: (owner, text) => {
        statuses.push([owner, text])
        if (owner === 'invalidate-observer') receipt.resolve()
      },
    },
  })
  runtimes.push(runtime)
  const author = await plugin('invalidate-author', authorSource)
  const modules = observer === undefined ? [author] : [author, await plugin('invalidate-observer', observer)]
  await runtime.bind({cwd: root, surface: 'terminal', isInteractive: true, sessionId: 'invalidate-289-test'})
  await runtime.reconcile(modules)
  expect(diagnostics).toEqual([])
  const call = (event = 'ui.render', command = 'invalidate') => runtime.dispatch('command.run', {
    command, args: event, origin: {kind: 'composer'}, presentation: {columns: 160, isFullscreen: true},
  }, async () => ({text: 'unanswered'}))
  return {runtime, author, modules, diagnostics, statuses, receipt, warning, call}
}

for (const event of events) {
  test(`real Worker $.ui.invalidate(${event}) synchronously returns undefined`, async () => {
    const {runtime, call, diagnostics, statuses} = await fixture()
    const result = await bounded(call(event), 'author receipt')
    expect(result).toEqual({text: JSON.stringify({immediateUndefined: true, awaitedUndefined: true})})
    await bounded(runtime.settle(), 'background invalidation settlement')
    expect(statuses).toEqual([['invalidate-author', 'author-receipt']])
    expect(diagnostics).toEqual([])
  })
}

for (const fails of [false, true]) {
  test(`actual Worker invalidation and middleware receipts precede held consumer draw, failure=${fails}`, async () => {
    const {runtime, call, diagnostics, statuses, receipt, warning} = await fixture(observerSource)
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const frames: {tree: unknown; drawing: number}[] = []
    let drawFinished = false
    let site: ModRenderSite | undefined
    let pending: Promise<unknown> | undefined
    try {
      site = await runtime.ui.mount({
        surface: 'terminal', component: 'AbovePrompt', requestId: 'real-band', props: {}, viewport: {columns: 160, rows: 40},
      }, {
        surface: 'terminal',
        async render(tree, drawing) {
          frames.push({tree, drawing})
          if (frames.length !== 2) return
          started.resolve()
          await release.promise
          drawFinished = true
          if (fails) throw new Error('held consumer draw failed')
        },
        unmount() {},
      })
      expect(frames).toHaveLength(1)
      expect(frames[0]!.tree).toMatchObject({type: 'Text', children: ['revision:0']})
      pending = call()
      await bounded(started.promise, 'real consumer draw start')
      await bounded(receipt.promise, 'Worker middleware queued receipt')
      expect(await bounded(pending, 'author queued receipt')).toEqual({
        text: JSON.stringify({immediateUndefined: true, awaitedUndefined: true}),
      })
      expect(drawFinished).toBe(false)
      expect(frames).toHaveLength(2)
      expect(statuses).toContainEqual(['invalidate-observer', JSON.stringify({event: 'ui.render', undefinedValue: true, origin: 'invalidate-author'})])
      expect(statuses).toContainEqual(['invalidate-author', 'author-receipt'])
      release.resolve()
      if (fails) {
        const fault = await bounded(warning.promise, 'owner draw warning')
        expect(fault).toMatchObject({plugin: 'invalidate-author', stage: 'ui.invalidate'})
        expect(fault.message).toContain('held consumer draw failed')
        expect(site.getTree()).toEqual(frames[0]!.tree)
        await bounded(runtime.ui.invalidateInstance({surface: 'terminal', component: 'AbovePrompt', requestId: 'real-band'}), 'recovery draw barrier')
      } else {
        await bounded(runtime.settle(), 'queued drawing settlement')
        expect(diagnostics).toEqual([])
      }
      expect(site.getTree()).toMatchObject({type: 'Text', children: ['revision:1']})
      expect(frames[1]!.drawing).not.toBe(frames[0]!.drawing)
    } finally {
      release.resolve()
      if (pending) await bounded(pending.catch(() => undefined), 'owned caller cleanup')
      if (site) await bounded(site.dispose(), 'owned site cleanup')
    }
  })
}

test('actual internal invalidateInstance remains a drawing completion barrier', async () => {
  const {runtime, call, diagnostics} = await fixture()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const frames: unknown[] = []
  let site: ModRenderSite | undefined
  let work: Promise<void> | undefined
  let completed = false
  try {
    site = await runtime.ui.mount({surface: 'terminal', component: 'AbovePrompt', requestId: 'internal-band', props: {}}, {
      surface: 'terminal',
      async render(tree) {
        frames.push(tree)
        if (frames.length === 2) {started.resolve(); await release.promise}
      },
      unmount() {},
    })
    expect(await call('', 'mutate')).toEqual({text: 'mutated'})
    work = runtime.ui.invalidateInstance({surface: 'terminal', component: 'AbovePrompt', requestId: 'internal-band'}).then(() => {completed = true})
    await bounded(started.promise, 'internal redraw start')
    expect(completed).toBe(false)
    release.resolve()
    await bounded(work, 'internal redraw completion')
    expect(completed).toBe(true)
    expect(frames).toHaveLength(2)
    expect(site.getTree()).toMatchObject({type: 'Text', children: ['revision:1']})
    expect(diagnostics).toEqual([])
  } finally {
    release.resolve()
    if (work) await bounded(work.catch(() => undefined), 'internal draw cleanup')
    if (site) await bounded(site.dispose(), 'internal site cleanup')
  }
})

test('public invalidation ignores an arbitrary middleware value', async () => {
  const {runtime, call, diagnostics} = await fixture(`export function register(on){on('ui.invalidate',()=>({value:{ignored:true}}))}`)
  expect(await bounded(call(), 'value override author receipt')).toEqual({
    text: JSON.stringify({immediateUndefined: true, awaitedUndefined: true}),
  })
  await bounded(runtime.settle(), 'value override settlement')
  expect(diagnostics).toEqual([])
})

for (const kind of ['deny', 'rewrite', 'direct-invalid'] as const) {
  test(`real Worker ${kind} invalidation failure warns the calling owner without rejecting its hook`, async () => {
    const source = kind === 'deny'
      ? `export function register(on){on('ui.invalidate',()=>({deny:'invalidation refused'}))}`
      : kind === 'rewrite'
        ? `export function register(on){on('ui.invalidate',(_,e,next)=>next({...e,event:'unsupported-event'}))}`
        : undefined
    const {runtime, call, diagnostics, statuses, warning} = await fixture(source)
    expect(await bounded(call(kind === 'direct-invalid' ? 'unsupported-event' : 'ui.render'), 'failure author receipt')).toEqual({
      text: JSON.stringify({immediateUndefined: true, awaitedUndefined: true}),
    })
    const event = await bounded(warning.promise, 'owner dropped-operation warning')
    expect(event.plugin).toBe('invalidate-author')
    expect(event.message).toContain('ui.invalidate')
    if (kind === 'deny') expect(event.message).toContain('invalidation refused')
    else expect(event.message).toMatch(/Unsupported UI invalidation|takes .*ui.render/)
    await bounded(runtime.settle(), 'failed operation settlement')
    expect(statuses).toEqual([['invalidate-author', 'author-receipt']])
    expect(diagnostics.some(item => item.plugin === 'invalidate-author' && item.stage === 'command.run')).toBe(false)
    expect(diagnostics.some(item => item.stage === 'worker')).toBe(false)
  })
}

test('an invalid original event cannot acquire admission through a middleware rewrite', async () => {
  const {runtime, call, statuses, warning} = await fixture(`export function register(on){
    on('ui.invalidate',async($,e,next)=>{
      await $.ui.status('invalid-input-reached-middleware');
      return next({...e,event:'ui.render'});
    });
  }`)
  const result = await bounded(call('unsupported-event'), 'invalid original author receipt')
  await bounded(runtime.settle(), 'invalid original settlement')
  expect(statuses).toEqual([['invalidate-author', 'author-receipt']])
  expect(result).toEqual({text: JSON.stringify({immediateUndefined: true, awaitedUndefined: true})})
  const event = await bounded(warning.promise, 'invalid original owner warning')
  expect(event.plugin).toBe('invalidate-author')
  expect(event.message).toContain('ui.invalidate')
  expect(event.message).toMatch(/Unsupported UI invalidation|takes .*ui.render/)
})

for (const unload of [false, true]) {
  test(`queued Worker invalidation after its hook receipt respects owner lifetime, unload=${unload}`, async () => {
    const {runtime, author, modules, call, diagnostics, statuses, receipt} = await fixture(`export function register(on){
      on('ui.invalidate',async($,e,next)=>{
        await $.store.get('invalidate-held');
        const result=await next(e);
        await $.ui.status('queued-owner-receipt');
        return result;
      });
    }`)
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const remove = runtime.registerHostHook({
      plugin: 'owned-invalidation-gate', tier: 'prepend', registration: {id: 991, event: 'store.get', hasCatch: false},
      async invoke(input, next) {
        if (input.key === 'invalidate-held') {started.resolve(); await release.promise}
        return next(input)
      },
    })
    const frames: unknown[] = []
    const painted = Promise.withResolvers<void>()
    let site: ModRenderSite | undefined
    try {
      site = await runtime.ui.mount({surface: 'terminal', component: 'AbovePrompt', requestId: 'queued-owner', props: {}}, {
        surface: 'terminal', render(tree) {
          frames.push(tree)
          if (JSON.stringify(tree).includes('revision:1')) painted.resolve()
        }, unmount() {},
      })
      expect(site.getTree()).toMatchObject({type: 'Text', children: ['revision:0']})
      const pending = call()
      await bounded(started.promise, 'middleware real store gate')
      expect(await bounded(pending, 'author finishes before middleware release')).toEqual({
        text: JSON.stringify({immediateUndefined: true, awaitedUndefined: true}),
      })
      expect(frames).toHaveLength(1)
      expect(statuses).toEqual([['invalidate-author', 'author-receipt']])
      if (unload) await runtime.reconcile(modules.filter(module => module !== author))
      const framesAtRetirement = frames.length
      release.resolve()
      if (unload) {
        await bounded(runtime.settle(), 'retired invalidation cleanup')
        expect(frames).toHaveLength(framesAtRetirement)
        expect(JSON.stringify(site.getTree())).not.toContain('revision:1')
        expect(statuses).not.toContainEqual(['invalidate-observer', 'queued-owner-receipt'])
      } else {
        await bounded(receipt.promise, 'middleware after normal author finish')
        await bounded(painted.promise, 'queued normal-finish consumer publication')
        expect(site.getTree()).toMatchObject({type: 'Text', children: ['revision:1']})
        expect(statuses).toContainEqual(['invalidate-observer', 'queued-owner-receipt'])
        expect(diagnostics).toEqual([])
      }
    } finally {
      release.resolve()
      remove()
      if (site) await bounded(site.dispose(), 'queued owner consumer cleanup')
    }
  })
}
