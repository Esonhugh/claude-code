import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime, type ModHostServices } from './runtime.js'
import { createModsSession } from './session.js'
import type { ModUiPresentation } from './ui.js'
import ts from 'typescript'
import { readFileSync } from 'node:fs'

let root: string
const runtimes: ReturnType<typeof createModsRuntime>[] = []
const envKeys = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_CACHE_DIR']
let saved: (string | undefined)[]
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mods-runtime-ui-'))
  saved = envKeys.map(key => process.env[key])
  for (const key of envKeys) process.env[key] = key.includes('CONFIG') || key.includes('CACHE') ? join(root, 'config') : root
})
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
  envKeys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i] })
  await rm(root, { recursive: true, force: true })
})
const wide: ModUiPresentation = { columns: 160, rows: 40, isFullscreen: true, composerEmpty: true, hasDialog: false, keyboardOwned: false }
const binding = (cwd: string) => ({ cwd, surface: 'terminal' as const, isInteractive: true, sessionId: 'ui-test' })
async function plugin(name: string, source: string) {
  const pluginRoot = join(root, name)
  await mkdir(pluginRoot)
  const entry = join(pluginRoot, 'register.ts')
  await writeFile(entry, source)
  return { name, storageId: name + '@test', pluginRoot, entrypoints: [entry] }
}
function fixture(overrides: ModHostServices = {}) {
  const statuses: unknown[] = [], logs: unknown[] = [], diagnostics: unknown[] = []
  const value = createModsRuntime({
    onDiagnostic: event => diagnostics.push(event),
    services: { uiPresentation: () => wide, uiStatus: (plugin, text) => { statuses.push([plugin, text]) }, uiLog: (plugin, text) => { logs.push([plugin, text]) }, ...overrides },
  })
  runtimes.push(value)
  return { value, statuses, logs, diagnostics }
}
const source = (label: string, fail = false) => `let count=0; export function register(on) {
  on('session.start', async ($,e,next) => { await $.ui.open({id:'panel',title:'${label}',focus:true}); ${fail ? "throw Error('failed UI start');" : 'return next(e);'} });
  on('ui.render', {component:'Pane'}, ($,e) => { const {Box,Button,Text}=$.ui.resolve(e); return Box({children:[Text({children:'${label}:'+count}),Button({key:'run',label:'Run',onPress:async () => { count++; await $.ui.status('${label}:'+count); await $.ui.log('clicked'); await $.ui.invalidate('ui.render'); }}),Button({key:'close',label:'Close',onPress:() => $.ui.close({id:'panel'})})]}); });
}`

test('activation subscribers see one generation across UI, commands, tools and agents', async () => {
  const generation = (label: string) => `export function register(on) {
    on('session.start', async ($,e,next) => {
      await $.command.register({name:'atomic',description:'${label}'});
      await $.tool.register({name:'atomic',description:'${label}'});
      await $.agent.register({name:'atomic',description:'${label}',prompt:'${label}'});
      await $.ui.open({id:'panel',title:'${label}'}); return next(e);
    });
    on('ui.render', ($,e) => $.ui.resolve(e).Text({children:'${label}'}));
    on('command.run', () => ({text:'${label}'}));
  }`
  const consumer = await plugin('atomic', generation('old'))
  const { value, diagnostics } = fixture()
  await value.bind(binding(root)); await value.reconcile([consumer])
  const seen: unknown[] = []
  const calls: Promise<unknown>[] = []
  const observe = () => {
    seen.push([
      value.ui.getSnapshot()[0]?.title,
      value.commands.getSnapshot()[0]?.description,
      value.tools.getSnapshot()[0]?.description({}, {} as never),
      value.agents.getSnapshot()[0]?.whenToUse,
    ])
    calls.push(value.dispatch('command.run', {command:'atomic',args:''}, async () => ({text:'core'})))
  }
  const unsubscribes = [value.ui, value.commands, value.tools, value.agents].map(registry => registry.subscribe(() => observe()))
  try {
    await writeFile(consumer.entrypoints[0]!, generation('new'))
    await value.reconcile([consumer])
    const results = await Promise.all(calls)
    expect(seen).toHaveLength(4)
    for (const row of seen as unknown[][]) expect(await Promise.all(row)).toEqual(['new','new','new','new'])
    expect(results).toEqual(Array(4).fill({text:'new'}))
    expect(diagnostics).toEqual([])
  } finally { unsubscribes.forEach(unsubscribe => unsubscribe()) }
})

test('ui.log preserves default, debug and rewritten sinks across activation buffering', async () => {
  const logs: unknown[]=[]
  const policy=await plugin('log-policy',`export function register(on) {
    on('ui.log', {text:'rewrite'}, ($,e,next)=>next({...e,to:'debug'}));
  }`)
  const owner=await plugin('logger',`export function register(on) {
    on('session.start',async($,e,next)=>{
      await $.ui.log('default'); await $.ui.log('debug',{to:'debug'}); await $.ui.log('rewrite'); return next(e);
    });
    on('tool.call',async($)=>{
      await $.ui.log('live',{to:'debug'});
      let rejected=false; try{await $.ui.log('invalid',{to:'other'});}catch{rejected=true;}
      return {result:rejected};
    });
  }`)
  const {value,diagnostics}=fixture({uiLog:(plugin,text,to)=>logs.push([plugin,text,to])})
  await value.bind(binding(root)); await value.reconcile([policy,owner])
  expect(logs).toEqual([['logger','default','transcript'],['logger','debug','debug'],['logger','rewrite','debug']])
  expect(await value.dispatch('tool.call',{tool:'Probe'},async()=>({result:'core'}))).toEqual({result:true})
  expect(logs.at(-1)).toEqual(['logger','live','debug'])
  expect(logs).toHaveLength(4)
  expect(diagnostics).toEqual([])
  const failed=await plugin('failed-logger',`export function register(on) {
    on('session.start',async($)=>{await $.ui.log('recovered',{to:'debug'});throw Error('failed start');});
  }`)
  await value.reconcile([policy,owner,failed])
  expect(logs).toHaveLength(5)
  expect(logs.at(-1)).toEqual(['failed-logger','recovered','debug'])
  expect(diagnostics).toContainEqual(expect.objectContaining({plugin:'failed-logger',stage:'session.start'}))
})

test('real Worker session.start opens a pane, redraws after a leased callback, closes and reloads', async () => {
  const consumer = await plugin('ui-owner', source('old'))
  const { value, statuses, logs, diagnostics } = fixture()
  await value.bind(binding(root))
  await value.reconcile([consumer])
  expect(diagnostics).toEqual([])
  const first = value.ui.getSnapshot()[0]!
  expect(first).toMatchObject({ id:'panel', title:'old', visible:true, placement:'dock' })
  const tree = first.tree as any
  await value.ui.interact(first.id, first.drawing!, tree.children[1].press, 'press', 'run')
  expect(statuses).toEqual([['ui-owner','old:1']])
  expect(logs).toEqual([['ui-owner','clicked']])
  const second = value.ui.getSnapshot()[0]!
  expect((second.tree as any).children[0].children).toEqual(['old:1'])
  const releasedCallback = await (first.owner as any).environment.invokeDrawing(first.drawing, tree.children[1].press.handle, [{}]).then(() => null, (error: Error) => error)
  expect(releasedCallback?.message).toContain('Unknown drawing callback')
  await expect(value.ui.interact(second.id, second.drawing!, {plugin:'unknown',handle:(second.tree as any).children[1].press.handle}, 'press', 'run')).rejects.toThrow(/stale/)
  await expect(value.ui.interact(first.id, first.drawing!, tree.children[1].press, 'press', 'run')).rejects.toThrow(/stale/)
  await writeFile(consumer.entrypoints[0]!, source('new'))
  await value.reconcile([consumer])
  expect(value.ui.getSnapshot()[0]!.title).toBe('new')
  await expect(value.ui.interact(second.id, second.drawing!, (second.tree as any).children[1].press, 'press', 'run')).rejects.toThrow(/stale/)
  const current = value.ui.getSnapshot()[0]!
  await value.ui.interact(current.id, current.drawing!, (current.tree as any).children[2].press, 'press', 'close')
  expect(value.ui.getSnapshot()).toEqual([])
  expect(diagnostics).toEqual([])
})

test('a recovered replacement publishes its drawing and completed UI side effects', async () => {
  const consumer = await plugin('ui-owner', source('old'))
  const { value, statuses } = fixture()
  await value.bind(binding(root)); await value.reconcile([consumer])
  const snapshot = value.ui.getSnapshot()
  await writeFile(consumer.entrypoints[0]!, source('failed', true).replace("throw Error('failed UI start')", "await $.ui.status('recovered'); throw Error('failed UI start')"))
  await value.reconcile([consumer])
  expect(value.ui.getSnapshot()).not.toBe(snapshot)
  expect(value.ui.getSnapshot()[0]?.title).toBe('failed')
  expect(statuses).toEqual([['ui-owner','recovered']])
  const pane = value.ui.getSnapshot()[0]!
  await value.ui.interact(pane.id,pane.drawing!,(pane.tree as any).children[1].press,'press','run')
  expect(statuses.at(-1)).toEqual(['ui-owner','failed:1'])
  await value.reconcile([])
  expect(value.ui.getSnapshot()).toEqual([])
})

test('uncaught startup failure preserves the old UI generation and suppresses buffered effects', async () => {
  const consumer = await plugin('ui-owner', source('old'))
  const statuses: unknown[] = [], logs: unknown[] = []
  let fail = false
  const value = createModsRuntime({
    onDiagnostic: () => { if (fail) { fail = false; throw Error('uncaught host failure') } },
    services: { uiPresentation: () => wide, uiStatus: (plugin,text) => { statuses.push([plugin,text]) }, uiLog: (plugin,text) => { logs.push([plugin,text]) } },
  })
  runtimes.push(value)
  await value.bind(binding(root)); await value.reconcile([consumer])
  const before = value.ui.getSnapshot()
  await writeFile(consumer.entrypoints[0]!, source('failed', true).replace("throw Error('failed UI start')", "await $.ui.status('discard'); await $.ui.log('discard'); throw Error('failed UI start')"))
  fail = true
  await value.reconcile([consumer])
  expect(value.ui.getSnapshot()).toBe(before)
  expect(statuses).toEqual([])
  expect(logs).toEqual([])
  const pane = before[0]!
  await value.ui.interact(pane.id,pane.drawing!,(pane.tree as any).children[1].press,'press','run')
  expect(statuses).toEqual([['ui-owner','old:1']])
})

test('engine.create withholding revokes even a captured synchronous UI resolve bridge', async () => {
  const consumer = await plugin('ui-owner', `let saved; export function register(on) {
    on('tool.call', ($,e) => { saved ??= () => $.ui.resolve({surface:'terminal',component:'Pane'}).Text({children:'ok'}); return {result:saved()}; });
  }`)
  const policy = await plugin('policy', `export function register(on) { on('engine.create', async ($,e,next) => {const below=await next(e); return {clock:below.clock,fs:below.fs,process:below.process,store:below.store,session:below.session,command:below.command};}); }`)
  const { value, diagnostics } = fixture()
  await value.bind(binding(root)); await value.reconcile([consumer])
  const input = {tool:'Read',tool_use_id:'test'}
  const initial = await value.dispatch('tool.call', input, async () => ({result:'core'}))
  expect(diagnostics).toEqual([])
  expect(initial).toMatchObject({result:{type:'Text'}})
  const oldGeneration = value.capture()
  await value.reconcile([policy,consumer])
  expect(diagnostics).toEqual([])
  try {
    expect(await oldGeneration.dispatch('tool.call', input, async () => ({result:'core'}))).toEqual({result:'core'})
  } finally { oldGeneration.release() }
  expect(await value.dispatch('tool.call', input, async () => ({result:'core'}))).toEqual({result:'core'})
  expect(diagnostics).toContainEqual(expect.objectContaining({plugin:'ui-owner',message:expect.stringMatching(/withdrawn|withheld/)}))
})

test('person opening policy follows command.run origin, not the command name', async () => {
  const consumer = await plugin('ui-owner', `export function register(on) {
    on('command.run', async ($,e) => { await $.ui.open({id:e.args}); return {}; });
    on('ui.render', ($,e) => $.ui.resolve(e).Text({children:'body'}));
  }`)
  const { value, diagnostics } = fixture({uiPresentation: () => ({...wide,columns:80,isFullscreen:false})})
  await value.bind(binding(root)); await value.reconcile([consumer])
  for (const [id,kind] of [['person','composer'],['shortcut','shortcut'],['auto','plugin']]) {
    await value.dispatch('command.run',{command:'arbitrary',args:id,origin:{kind},presentation:{columns:80,isFullscreen:false}},async () => ({}))
  }
  expect(value.ui.getSnapshot().map(pane => [pane.id,pane.visible])).toEqual([['person',true],['shortcut',true],['auto',false]])
  expect(diagnostics).toEqual([])
})

test('a timer scheduled by a person command does not retain person UI opening privilege', async () => {
  const consumer = await plugin('ui-owner',`export function register(on) {
    on('command.run',($,e) => {$.clock.after(1,async () => {await $.ui.open({id:'timer'}); await $.ui.status('timer done')}); return {};});
    on('ui.render',($,e) => $.ui.resolve(e).Text({children:'body'}));
  }`)
  const done = Promise.withResolvers<void>()
  const {value,diagnostics} = fixture({uiPresentation:() => ({...wide,columns:80}),uiStatus:() => done.resolve()})
  await value.bind(binding(root)); await value.reconcile([consumer])
  await value.dispatch('command.run',{command:'any',args:'',origin:{kind:'composer'},presentation:{columns:80,isFullscreen:true}},async () => ({}))
  await done.promise
  expect(value.ui.getSnapshot()[0]).toMatchObject({id:'timer',visible:false})
  expect(diagnostics).toEqual([])
})

test('public ui.focus addresses the calling plugin element and raises one plugin-origin focus event', async () => {
  const consumer = await plugin('ui-owner', `export function register(on) {
    on('session.start', async ($,e,next) => { await $.ui.open({id:'panel',focus:true}); return next(e); });
    on('ui.render', ($,e) => { const {Box,Button}=$.ui.resolve(e); return Box({children:[
      Button({key:'first',label:'First',onPress:()=>{}}),
      Button({key:'second',label:'Second',onPress:()=>{}}),
    ]}); });
    on('command.run', async ($,e) => { const result=await $.ui.focus({requestId:'panel',key:'second'}); await $.ui.status(JSON.stringify(result)); return {}; });
  }`)
  const policy = await plugin('focus-policy', `export function register(on) {
    on('ui.focus', async ($,e,next) => { await $.ui.status(JSON.stringify(e)); return next(e); });
  }`)
  const {value,statuses,diagnostics} = fixture()
  await value.bind(binding(root)); await value.reconcile([policy,consumer])

  await value.dispatch('command.run',{command:'focus',args:'',origin:{kind:'composer'},presentation:{columns:160,isFullscreen:true}},async () => ({}))

  expect(diagnostics).toEqual([])
  expect(statuses).toEqual([
    ['focus-policy',JSON.stringify({component:'Pane',requestId:'panel',plugin:'ui-owner',element:'second',origin:{kind:'plugin',name:'ui-owner'}})],
    ['ui-owner','{}'],
  ])
  expect(value.ui.getSnapshot()[0]).toMatchObject({focused:true,focusedElement:'second'})
})

test('person focus enters an unfocused Worker pane while public plugin focus cannot steal it', async () => {
  const consumer = await plugin('ui-owner', `export function register(on) {
    on('session.start', async ($,e,next) => { await $.ui.open({id:'panel'}); return next(e); });
    on('ui.render', ($,e) => { const {Box,Button}=$.ui.resolve(e); return Box({children:[
      Button({key:'first',label:'First',onPress:()=>{}}),
      Button({key:'second',label:'Second',onPress:()=>{}}),
    ]}); });
    on('command.run', async ($) => { await $.ui.status(JSON.stringify(await $.ui.focus({requestId:'panel',key:'first'}))); return {}; });
  }`)
  const policy = await plugin('focus-policy', `let mode='rewrite'; export function register(on) {
    on('command.run', ($,e,next) => { if(e.command==='mode'){mode=e.args;return {};} return next(e); });
    on('ui.focus', ($,e,next) => {
      if(mode==='deny') return {deny:'held'};
      if(mode==='stay') return {stay:true};
      return next({element:'second'});
    });
  }`)
  const { value, statuses, diagnostics } = fixture()
  await value.bind(binding(root)); await value.reconcile([policy, consumer])
  const pane = value.ui.getSnapshot()[0]!
  expect(pane).toMatchObject({ visible: true, focused: false })
  await value.dispatch('command.run', { command: 'focus', args: '', origin: { kind: 'composer' } }, async () => ({}))
  expect(statuses).toEqual([['ui-owner', JSON.stringify({ deny: 'site does not hold the keyboard' })]])
  expect(await value.ui.focus(pane.owner, {
    requestId: pane.id, element: 'first', origin: { kind: 'person' },
  }, wide)).toEqual({ focused: true, element: 'second' })
  expect(value.ui.getSnapshot()[0]).toMatchObject({ focused: true, focusedElement: 'second' })
  for (const [mode, result] of [['deny', { deny: 'held' }], ['stay', { stay: true }]] as const) {
    await value.dispatch('command.run', { command: 'mode', args: mode, origin: { kind: 'composer' } }, async () => ({}))
    expect(await value.ui.focus(pane.owner, {
      requestId: pane.id, element: 'first', origin: { kind: 'person' },
    }, wide)).toEqual({ ...result, focused: true, element: 'second' })
  }
  expect(diagnostics).toEqual([])
})

test('Worker wheel middleware receives body-relative pointers and consumes a virtual list without outer scrolling', async () => {
  const consumer = await plugin('ui-owner', `let row=0; export function register(on) {
    on('session.start', async ($,e,next) => { await $.ui.open({id:'panel'}); return next(e); });
    on('ui.render', ($,e) => $.ui.resolve(e).Text({children:'row:'+row}));
    on('ui.scroll', async ($,e,next) => {
      await $.ui.status(JSON.stringify(e));
      if(e.pointer.column>=10) return next(e);
      row=Math.max(0,row+e.by);
      await $.ui.invalidate('ui.render');
      return {};
    });
  }`)
  const { value, statuses, diagnostics } = fixture()
  await value.bind(binding(root)); await value.reconcile([consumer])
  const pane = value.ui.getSnapshot()[0]!
  await value.ui.reportMetrics(pane.id, { bodyRows: 4, contentRows: 4 })
  for (const [by, row] of [[3, 3], [-1, 2]] as const) {
    await value.ui.scroll(pane.owner, {
      requestId: pane.id, by, pointer: { column: 2, row: 1 }, origin: { kind: 'person' },
    })
    expect(value.ui.getSnapshot()[0]).toMatchObject({ focused: false, scrollOffset: 0 })
    expect((value.ui.getSnapshot()[0]!.tree as any).children).toEqual([`row:${row}`])
  }
  expect(statuses).toEqual([3, -1].map(by => ['ui-owner', JSON.stringify({
    component: 'Pane', requestId: 'panel', offset: 0, by, bodyRows: 4, contentRows: 4,
    origin: { kind: 'person' }, pointer: { column: 2, row: 1 },
  })]))
  await value.ui.reportMetrics(pane.id, { bodyRows: 4, contentRows: 12 })
  await value.ui.scroll(pane.owner, {
    requestId: pane.id, by: 3, pointer: { column: 12, row: 1 }, origin: { kind: 'person' },
  })
  expect(value.ui.getSnapshot()[0]!.scrollOffset).toBe(3)
  expect(diagnostics).toEqual([])
})

test('public focus and scroll wrappers project known fields before crossing the Worker bridge', async () => {
  const consumer = await plugin('ui-owner', `export function register(on) {
    on('session.start', async ($,e,next) => { await $.ui.open({id:'panel',focus:true}); return next(e); });
    on('ui.render', ($,e) => { const {Box,Button}=$.ui.resolve(e); return Box({children:[
      Button({key:'first',label:'First',onPress:()=>{}}),
      Button({key:'second',label:'Second',onPress:()=>{}}),
    ]}); });
    on('command.run', async ($) => {
      const focus=await $.ui.focus({requestId:'panel',key:'second',get ignored(){throw Error('unknown focus getter')}});
      let focusSync; try { $.ui.focus({get requestId(){throw Error('selected focus getter')},key:'second'}); } catch(error) { focusSync=error.message; }
      const scroll=await $.ui.scroll({to:'end',in:'panel',get ignored(){throw Error('unknown scroll getter')}});
      let scrollSync; try { $.ui.scroll({get to(){throw Error('selected scroll getter')},in:'panel'}); } catch(error) { scrollSync=error.message; }
      let focusHostSync='returned',focusHostAsync;
      try {
        const pending=$.ui.focus({requestId:'',key:'second'});
        try { await pending; } catch(error) { focusHostAsync=error.message; }
      } catch(error) { focusHostSync=error.message; }
      let scrollHostSync='returned',scrollHostAsync;
      try {
        const pending=$.ui.scroll({to:'end'});
        try { await pending; } catch(error) { scrollHostAsync=error.message; }
      } catch(error) { scrollHostSync=error.message; }
      const denied=await $.ui.focus({requestId:'missing',key:'second'});
      await $.ui.status(JSON.stringify({focus,focusSync,scroll,scrollSync,focusHostSync,focusHostAsync,scrollHostSync,scrollHostAsync,denied}));
      return {};
    });
  }`)
  const {value,statuses,diagnostics} = fixture()
  await value.bind(binding(root)); await value.reconcile([consumer])

  await value.dispatch('command.run',{command:'wrapper',args:'',origin:{kind:'composer'},presentation:{columns:160,isFullscreen:true}},async () => ({}))

  expect(value.ui.getSnapshot()[0]).toMatchObject({focusedElement:'second'})
  expect(statuses).toEqual([['ui-owner',JSON.stringify({
    focus:{},
    focusSync:'selected focus getter',
    scroll:{},
    scrollSync:'selected scroll getter',
    focusHostSync:'returned',
    focusHostAsync:'ui.focus takes { requestId, key }',
    scrollHostSync:'returned',
    scrollHostAsync:'ui.scroll takes { to, in?, block? }',
    denied:{deny:'site is not open'},
  })]])
  expect(diagnostics).toEqual([])
})

test('public ui.scroll resolves end and keyed targets before raising one plugin-origin scroll event', async () => {
  const consumer = await plugin('ui-owner', `export function register(on) {
    on('session.start', async ($,e,next) => { await $.ui.open({id:'panel'}); return next(e); });
    on('ui.render', ($,e) => { const {Box,Text}=$.ui.resolve(e); return Box({children:[Box({key:'target',children:[Text({children:'Target'})]})]}); });
    on('command.run', async ($,e) => {
      const args=e.args==='end' ? {to:'end',in:'panel'} : {to:{key:'target'},in:'panel',block:'center'};
      const result=await $.ui.scroll(args); await $.ui.status(JSON.stringify(result)); return {};
    });
  }`)
  const policy = await plugin('scroll-policy', `export function register(on) {
    on('ui.scroll', async ($,e,next) => { await $.ui.status(JSON.stringify(e)); return next(e); });
  }`)
  const {value,statuses,diagnostics} = fixture()
  await value.bind(binding(root)); await value.reconcile([policy,consumer])
  await value.ui.reportMetrics('panel', {
    bodyRows: 4,
    contentRows: 12,
    keyRows: [{plugin:'ui-owner',key:'target',top:6,bottom:7}],
  })

  await value.dispatch('command.run',{command:'scroll',args:'end',origin:{kind:'composer'},presentation:{columns:160,isFullscreen:true}},async () => ({}))
  expect(value.ui.getSnapshot()[0]!.scrollOffset).toBe(8)
  await value.dispatch('command.run',{command:'scroll',args:'key',origin:{kind:'composer'},presentation:{columns:160,isFullscreen:true}},async () => ({}))

  expect(value.ui.getSnapshot()[0]!.scrollOffset).toBe(5)
  expect(statuses).toEqual([
    ['scroll-policy',JSON.stringify({component:'Pane',requestId:'panel',offset:8,by:8,bodyRows:4,contentRows:12,origin:{kind:'plugin',name:'ui-owner'}})],
    ['ui-owner','{}'],
    ['scroll-policy',JSON.stringify({component:'Pane',requestId:'panel',offset:5,by:-3,bodyRows:4,contentRows:12,origin:{kind:'plugin',name:'ui-owner'}})],
    ['ui-owner','{}'],
  ])
  expect(diagnostics).toEqual([])
})

test('public ui.scroll denies unsupported transcript targets without raising a pane scroll event', async () => {
  const consumer = await plugin('ui-owner', `export function register(on) {
    on('session.start', async ($,e,next) => { await $.ui.open({id:'panel'}); return next(e); });
    on('ui.render', ($,e) => $.ui.resolve(e).Text({children:'body'}));
    on('command.run', async ($,e) => {
      const result=await $.ui.scroll({to:{requestId:e.args}}); await $.ui.status(JSON.stringify(result)); return {};
    });
  }`)
  const policy = await plugin('scroll-policy', `export function register(on) {
    on('ui.scroll', async ($,e,next) => { await $.ui.status('unexpected scroll'); return next(e); });
  }`)
  const {value,statuses,diagnostics} = fixture()
  await value.bind(binding(root)); await value.reconcile([policy,consumer])

  await value.dispatch('command.run',{command:'scroll',args:'panel',origin:{kind:'composer'},presentation:{columns:160,isFullscreen:true}},async () => ({}))
  await value.dispatch('command.run',{command:'scroll',args:'message-1',origin:{kind:'composer'},presentation:{columns:160,isFullscreen:true}},async () => ({}))

  expect(statuses).toEqual([
    ['ui-owner',JSON.stringify({deny:'nothing around that site scrolls'})],
    ['ui-owner',JSON.stringify({deny:'transcript not scrollable here'})],
  ])
  expect(diagnostics).toEqual([])
})

test('every actual render participant owns its callbacks, not just the pane opener', async () => {
  const decorator = await plugin('decorator', `export function register(on) { on('ui.render',async ($,e,next) => {const {Box,Button}=$.ui.resolve(e); return Box({children:[await next(e),Button({key:'decorate',label:'Decorate',onPress:() => $.ui.status('decorator pressed')})]}); }); }`)
  const consumer = await plugin('ui-owner', source('owner'))
  const {value,statuses,diagnostics} = fixture()
  await value.bind(binding(root)); await value.reconcile([decorator,consumer])
  const first = value.ui.getSnapshot()[0]!
  const tree = first.tree as any
  await value.ui.interact(first.id,first.drawing!,tree.children[1].press,'press','decorate')
  expect(statuses).toEqual([['decorator','decorator pressed']])
  await value.reconcile([])
  expect(value.ui.getSnapshot()).toEqual([])
  await expect(value.ui.interact(first.id,first.drawing!,tree.children[1].press,'press','decorate')).rejects.toThrow(/stale/)
  expect(diagnostics).toEqual([])
})

test('retirement closes panes even while an old runtime snapshot keeps the environment alive', async () => {
  const consumer = await plugin('ui-owner',source('old'))
  const {value,diagnostics} = fixture()
  await value.bind(binding(root)); await value.reconcile([consumer])
  const old = value.ui.getSnapshot()[0]!
  const lease = value.capture()
  try {
    await value.reconcile([])
    expect(value.ui.getSnapshot()).toEqual([])
    await expect(value.ui.interact(old.id,old.drawing!,(old.tree as any).children[1].press,'press','run')).rejects.toThrow(/stale/)
  } finally {lease.release()}
  expect(diagnostics).toEqual([])
})

test('reloading a render participant redraws a surviving pane with the new participant generation', async () => {
  const decoratorSource = (label: string) => `export function register(on) {on('ui.render',async ($,e,next) => {const {Box,Button}=$.ui.resolve(e); return Box({children:[await next(e),Button({key:'decorate',label:'${label}',onPress:() => $.ui.status('${label}')})]});});}`
  const decorator = await plugin('decorator',decoratorSource('old'))
  const consumer = await plugin('ui-owner',source('owner'))
  const {value,statuses,diagnostics} = fixture()
  await value.bind(binding(root)); await value.reconcile([decorator,consumer])
  const old = value.ui.getSnapshot()[0]!
  await writeFile(decorator.entrypoints[0]!,decoratorSource('new'))
  await value.reconcile([decorator,consumer])
  expect(diagnostics).toEqual([])
  const current = value.ui.getSnapshot()[0]!
  expect(current.drawing).not.toBe(old.drawing)
  await expect(value.ui.interact(old.id,old.drawing!,(old.tree as any).children[1].press,'press','decorate')).rejects.toThrow(/stale/)
  await value.ui.interact(current.id,current.drawing!,(current.tree as any).children[1].press,'press','decorate')
  expect(statuses).toContainEqual(['decorator','new'])
})

test('recovered replacement retires the old drawing and admits its new resolver', async () => {
  const consumer = await plugin('ui-owner',source('old'))
  const {value,statuses} = fixture()
  await value.bind(binding(root)); await value.reconcile([consumer])
  const before = value.ui.getSnapshot()
  await writeFile(consumer.entrypoints[0]!,`export function register(on) {
    on('session.start',async ($,e,next) => {await $.ui.close({id:'panel'}); await $.ui.invalidate('ui.render'); throw Error('candidate failed');});
    on('ui.render',($,e) => $.ui.resolve(e).Text({children:'new generation'}));
    on('command.run',async ($) => {await $.ui.open({id:'panel'});return {};});
  }`)
  await value.reconcile([consumer])
  expect(value.ui.getSnapshot()).toEqual([])
  const pane = before[0]!
  await expect(value.ui.interact(pane.id,pane.drawing!,(pane.tree as any).children[1].press,'press','run')).rejects.toThrow(/stale/)
  await value.dispatch('command.run',{command:'open',args:''},async () => ({}))
  expect((value.ui.getSnapshot()[0]!.tree as any).children).toEqual(['new generation'])
  expect(statuses).toEqual([])
})

test('a new subscriber can invoke the just-published drawing generation', async () => {
  const consumer = await plugin('ui-owner',source('new'))
  const {value,statuses,diagnostics} = fixture()
  await value.bind(binding(root))
  let pending: Promise<unknown> | undefined
  const unsubscribe = value.ui.subscribe(() => {
    const pane = value.ui.getSnapshot()[0]
    if (pane?.drawing && !pending) pending = value.ui.interact(pane.id,pane.drawing,(pane.tree as any).children[1].press,'press','run')
  })
  await value.reconcile([consumer]); unsubscribe()
  await pending
  expect(statuses).toContainEqual(['ui-owner','new:1'])
  expect(diagnostics).toEqual([])
})

test('ui.press rewrites never select a different plugin callback environment', async () => {
  const decorator = await plugin('decorator', `export function register(on) {
    on('ui.render',async ($,e,next) => {const {Box,Button}=$.ui.resolve(e); return Box({children:[await next(e),Button({key:'decorate',label:'Decorate',onPress:() => $.ui.status('right callback')})]}); });
    on('ui.press',($,e,next) => next({...e,plugin:'ui-owner'}));
  }`)
  const consumer = await plugin('ui-owner', source('owner'))
  const {value,statuses,diagnostics} = fixture()
  await value.bind(binding(root)); await value.reconcile([decorator,consumer])
  expect(diagnostics).toEqual([])
  const pane = value.ui.getSnapshot()[0]!
  expect((pane.tree as any).children[1].props.key).toBe('decorate')
  await value.ui.interact(pane.id,pane.drawing!,(pane.tree as any).children[1].press,'press','decorate')
  expect(statuses).toEqual([['decorator','right callback']])
  expect(diagnostics).toEqual([])
})

test('ModsSession UI subscriptions are stable before runtime creation and notify on real activation', async () => {
  const consumer = await plugin('ui-owner',source('session'))
  const session = createModsSession({
    isTrusted:true,
    getSettings: () => ({userSettings:{},flagSettings:{},policySettings:{},hookPolicy:{managedOnly:false,allDisabled:false}}),
    loadPlugins: async () => [{name:consumer.name,source:consumer.storageId,path:consumer.pluginRoot,enabled:true,manifest:{name:consumer.name},repository:consumer.storageId,hookModules:[{configPath:join(consumer.pluginRoot,'hooks.json'),paths:consumer.entrypoints}]}] as any,
  })
  const empty = session.ui.getSnapshot()
  expect(session.ui.getSnapshot()).toBe(empty)
  let notifications = 0
  const unsubscribe = session.ui.subscribe(() => { notifications++ })
  try {
    await session.bind(binding(root),undefined,{uiPresentation:() => wide,uiStatus:() => {},uiLog:() => {}})
    expect(session.ui.getSnapshot()[0]?.title).toBe('session')
    const current = session.ui.getSnapshot()
    expect(session.ui.getSnapshot()).toBe(current)
    expect(notifications).toBeGreaterThan(0)
    await session.dispose()
    expect(session.ui.getSnapshot()).toEqual([])
  } finally { unsubscribe(); await session.dispose() }
})

test('REPL pane callbacks call the live UI host and keep independent dock/inline placement', async () => {
  const source = readFileSync(new URL('../../screens/REPL.tsx',import.meta.url),'utf8')
  const ast = ts.createSourceFile('REPL.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
  let callback: ts.Expression | undefined
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'renderModPane') callback = node.initializer
    ts.forEachChild(node,visit)
  }
  visit(ast)
  expect(callback).toBeDefined()
  const js = ts.transpileModule(`const extracted = ${callback!.getText(ast)};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,module:ts.ModuleKind.None}}).outputText
  const calls: unknown[] = []
  const landing = {focused:true,element:'rewritten'}
  const ui = {
    interact:async (...args:unknown[]) => {calls.push(['interact',...args])},
    close:async (...args:unknown[]) => {calls.push(['close',...args])},
    focus:async (...args:unknown[]) => {calls.push(['focus',...args]); return landing},
    scroll:async (...args:unknown[]) => {calls.push(['scroll',...args])},
    reportMetrics:(...args:unknown[]) => {calls.push(['metrics',...args])},
    getSnapshot:() => [{...pane,revision:42}],
  }
  const pane = {id:'panel',plugin:'owner',owner:{},visible:true,focused:true,bodyRows:10,contentRows:20}
  const scope = {
    React:{createElement:(_type:unknown,props:unknown) => props}, ModsPane:'ModsPane',
    modPaneFocused:false, modUiPresentation:{...wide}, modUiPresentationRef:{current:{...wide}},
    modPanes:[pane], modsSession:{runtime:{ui}} as {runtime:{ui:typeof ui}} | undefined,
    logError:() => {},
  }
  const render = new Function('scope',`with(scope) {${js}; return extracted;}`)(scope)
  const props = render(pane)
  expect(props.pane.focused).toBe(false)
  expect(props.canFocus).toBe(true)
  scope.modPaneFocused = true
  expect(render(pane).pane).toBe(pane)

  const press = {plugin:'owner',handle:10}
  const pointer = {column:7,row:2}
  // An already-rendered callback must read the current presentation, not its render snapshot.
  const currentPresentation = {...wide,hasDialog:true,rows:27}
  scope.modUiPresentationRef.current = currentPresentation
  await props.onInteract(pane,1,press,'press','run')
  await props.onClose(pane)
  expect(await props.onFocus(pane,'run')).toEqual({...landing,revision:42})
  await props.onScroll(pane,3)
  await props.onScroll(pane,-1,pointer)
  props.onReportMetrics(pane,{bodyRows:10,contentRows:20})
  props.onReportMetrics(pane,{bodyRows:10,contentRows:20,keyRows:[{plugin:'owner',key:'run',top:1,bottom:2}]})
  props.onReportMetrics(pane,{bodyRows:10,contentRows:21,keyRows:[{plugin:'owner',key:'run',top:2,bottom:3}]})
  expect(calls).toEqual([
    ['interact','panel',1,press,'press','run',undefined],
    ['close',pane.owner,'panel',{kind:'person'}],
    ['focus',pane.owner,{requestId:'panel',element:'run',origin:{kind:'person'}},currentPresentation],
    ['scroll',pane.owner,{requestId:'panel',by:3,pointer:undefined,origin:{kind:'person'}}],
    ['scroll',pane.owner,{requestId:'panel',by:-1,pointer,origin:{kind:'person'}}],
    ['metrics','panel',{bodyRows:10,contentRows:20,keyRows:[{plugin:'owner',key:'run',top:1,bottom:2}]}],
    ['metrics','panel',{bodyRows:10,contentRows:21,keyRows:[{plugin:'owner',key:'run',top:2,bottom:3}]}],
  ])

  for (const changes of [{composerEmpty:false},{hasDialog:true},{keyboardOwned:true}]) {
    scope.modUiPresentation = {...wide,...changes}
    expect(render(pane).canFocus).toBe(false)
  }
  scope.modUiPresentation = {...wide}
  for (const other of [
    {...pane,id:'other',focused:false}, {...pane,id:'other',visible:false},
  ]) {
    scope.modPanes = [pane,other]
    expect(render(pane).canFocus).toBe(true)
  }
  scope.modPanes = [pane,{...pane,id:'other'}]
  expect(render(pane).canFocus).toBe(false)
  scope.modPanes = [pane]
  expect(render({...pane,focused:false}).canFocus).toBe(true)

  scope.modsSession = undefined
  expect(await props.onFocus(pane,'run')).toEqual({focused:false})
  await expect(props.onInteract(pane,1,press,'press','run')).rejects.toThrow('Mod UI host is unavailable')
  expect(calls).toHaveLength(7)
  expect(source).toContain('{modInline.map(renderModPane)}')
  expect(source).toContain('{modDock.map(renderModPane)}')
})

test('unsupported headless UI surface rejects open explicitly', async () => {
  const consumer = await plugin('ui-owner', source('headless'))
  const {value,diagnostics} = fixture({uiPresentation:undefined})
  await value.bind({...binding(root),surface:null,isInteractive:false}); await value.reconcile([consumer])
  expect(value.ui.getSnapshot()).toEqual([])
  expect(diagnostics).toContainEqual(expect.objectContaining({stage:'session.start',message:expect.stringMatching(/unsupported|unavailable|terminal/i)}))
})

test('ui.blit updates an owned mounted Raster without rerunning ui.render and rejects stale dimensions', async () => {
  const cell = (character: string) => {
    const bytes = Buffer.alloc(12)
    bytes.writeUInt32LE(character.charCodeAt(0), 0)
    bytes.writeUInt32LE(0x01000000, 4)
    bytes.writeUInt32LE(0x01000000, 8)
    return bytes.toString('base64')
  }
  const consumer = await plugin('blit-owner', `let draws=0; export function register(on) {
    on('session.start',async($,e,next)=>{await $.ui.open({id:'media'});return next(e)});
    on('ui.render',($,e)=>{draws++;return $.ui.resolve(e).Raster({key:'pixels',columns:1,rows:1,cells:'${cell('A')}'})});
    on('command.run',async($)=>{
      const changed=await $.ui.blit({requestId:'media',key:'pixels',cells:'${cell('B')}',columns:1,rows:1});
      const wrong=await $.ui.blit({requestId:'media',key:'pixels',cells:'${cell('C')}',columns:2,rows:1});
      await $.ui.status(JSON.stringify({changed,wrong,draws}));return {};
    });
  }`)
  const {value,statuses,diagnostics}=fixture()
  await value.bind(binding(root));await value.reconcile([consumer])
  const before=value.ui.getSnapshot()[0]!
  expect({before:Boolean(before),diagnostics}).toEqual({before:true,diagnostics:[]})
  await value.dispatch('command.run',{command:'blit',args:'',origin:{kind:'composer'}},async()=>({}))
  const after=value.ui.getSnapshot()[0]!
  expect(after.drawing).toBe(before.drawing)
  expect((after.tree as any).props.cells).toBe(cell('B'))
  expect(statuses).toEqual([['blit-owner',JSON.stringify({changed:{},wrong:{deny:'mounted dimensions do not match'},draws:1})]])
  expect(diagnostics).toEqual([])
})

test('ui.blit middleware may rewrite payload but cannot redirect the mounted address or kind', async () => {
  const cell = (character: string) => {
    const bytes = Buffer.alloc(12)
    bytes.writeUInt32LE(character.charCodeAt(0), 0)
    bytes.writeUInt32LE(0x01000000, 4)
    bytes.writeUInt32LE(0x01000000, 8)
    return bytes.toString('base64')
  }
  const policy = await plugin('blit-policy', `export function register(on) {
    on('ui.blit',async($,e,next)=>{
      if(e.cells==='${cell('B')}') return next({...e,cells:'${cell('C')}'});
      try {await next({...e,key:'other'})} catch(error) {await $.ui.status(error.message)}
      try {await next({...e,cells:undefined,source:{png:'AAAA'}})} catch(error) {await $.ui.status(error.message)}
      return next(e);
    });
  }`)
  const consumer = await plugin('blit-owner', `export function register(on) {
    on('session.start',async($,e,next)=>{await $.ui.open({id:'media'});return next(e)});
    on('ui.render',($,e)=>$.ui.resolve(e).Raster({key:'pixels',columns:1,rows:1,cells:'${cell('A')}'}));
    on('command.run',async($,e)=>{await $.ui.blit({requestId:'media',key:'pixels',cells:e.args==='rewrite'?'${cell('B')}':'${cell('D')}'});return {}});
  }`)
  const {value,statuses,diagnostics}=fixture()
  await value.bind(binding(root));await value.reconcile([policy,consumer])
  await value.dispatch('command.run',{command:'blit',args:'rewrite',origin:{kind:'composer'}},async()=>({}))
  expect((value.ui.getSnapshot()[0]!.tree as any).props.cells).toBe(cell('C'))
  await value.dispatch('command.run',{command:'blit',args:'guards',origin:{kind:'composer'}},async()=>({}))
  expect((value.ui.getSnapshot()[0]!.tree as any).props.cells).toBe(cell('D'))
  expect(statuses).toEqual([
    ['blit-policy','Mod UI blit cannot rewrite requestId or key'],
    ['blit-policy','Mod UI blit cannot change the mounted element kind'],
  ])
  expect(diagnostics).toEqual([])
})

test('ui.blit cannot address another plugin drawing and expires after close', async () => {
  const bytes = Buffer.alloc(12)
  bytes.writeUInt32LE('A'.charCodeAt(0), 0)
  bytes.writeUInt32LE(0x01000000, 4)
  bytes.writeUInt32LE(0x01000000, 8)
  const cells = bytes.toString('base64')
  const owner = await plugin('blit-owner', `export function register(on) {
    on('session.start',async($,e,next)=>{await $.ui.open({id:'media'});return next(e)});
    on('ui.render',($,e)=>$.ui.resolve(e).Raster({key:'pixels',columns:1,rows:1,cells:'${cells}'}));
  }`)
  const stranger = await plugin('blit-stranger', `export function register(on) {
    on('command.run',async($)=>{const result=await $.ui.blit({requestId:'media',key:'pixels',cells:'${cells}'});await $.ui.status(JSON.stringify(result));return {}});
  }`)
  const {value,statuses,diagnostics}=fixture()
  await value.bind(binding(root));await value.reconcile([owner,stranger])
  await value.dispatch('command.run',{command:'blit',args:'',origin:{kind:'composer'}},async()=>({}))
  expect(statuses).toEqual([['blit-stranger',JSON.stringify({deny:'no owned Raster or Image is mounted under that key'})]])
  const pane=value.ui.getSnapshot()[0]!
  await value.ui.close(pane.owner,pane.id,{kind:'person'})
  expect(await value.ui.blit(pane.owner,{requestId:pane.id,key:'pixels',cells})).toEqual({deny:'site is not open'})
  expect(diagnostics).toEqual([])
})

test('a render decorator can invalidate panes opened by another plugin', async () => {
  const decorator = await plugin('decorator', `export function register(on) {
    let count=0;
    on('ui.render',async ($,e,next) => {const {Box,Text}=$.ui.resolve(e); return Box({children:[await next(e),Text({children:'decorator:'+count})]});});
    on('command.run',async ($) => {count++;await $.ui.invalidate('ui.render');return {}});
  }`)
  const consumer = await plugin('ui-owner', source('owner'))
  const {value,diagnostics} = fixture()
  await value.bind(binding(root)); await value.reconcile([decorator,consumer])
  const before = value.ui.getSnapshot()[0]!
  expect(JSON.stringify(before.tree)).toContain('decorator:0')

  await value.dispatch('command.run',{command:'refresh',args:'',origin:{kind:'composer'},presentation:{columns:160,isFullscreen:true}},async () => ({}))

  const current = value.ui.getSnapshot()[0]!
  expect(current.drawing).not.toBe(before.drawing)
  expect(JSON.stringify(current.tree)).toContain('decorator:1')
  expect(diagnostics).toEqual([])
})
