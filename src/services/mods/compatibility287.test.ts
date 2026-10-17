import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createModsRuntime } from './runtime.js'
import { loadModDeclaration } from './loader.js'
import { validatePluginContents } from '../../utils/plugins/validatePlugin.js'

// Retain all fixture evidence; this suite never removes files or writes outside the repository.
const evidenceRoot = new URL('../../../.claude-test-evidence/mods-287/', import.meta.url).pathname

async function plugin(source: string) {
  await mkdir(evidenceRoot, { recursive: true })
  const root = await mkdtemp(join(evidenceRoot, 'plugin-'))
  const entry = join(root, 'register.ts')
  await writeFile(entry, source)
  return { name: 'fixture', storageId: 'fixture@inline', pluginRoot: root, entrypoints: [entry] }
}

test('scans official state helpers by imported identity and follows derived sources', async () => {
  const input = await plugin(`import {atom, derive, memberOf, read as get, update} from 'claude-code';
    const count = atom({plugin:'fixture', key:'count'}, 0);
    const row = atom({plugin:'fixture', key:'rows'}, null);
    const combined = derive([count, memberOf(row, {requestId:'one'})], (a, b) => [a,b]);
    export function register(on) {
      on('command.run', async ($) => {
        await update($, count, value => value + 1);
        return get($, combined);
      });
    }`)
  const declaration = await loadModDeclaration(input)
  expect(declaration.calls).toEqual(expect.arrayContaining(['state.get', 'state.set']))
  expect(declaration.state).toEqual({
    reads: [{plugin:'fixture', key:'count'}, {plugin:'fixture', key:'rows'}],
    writes: [{plugin:'fixture', key:'count'}],
  })
})

test('official atom read update helpers execute inside the plugin VM', async () => {
  const input = await plugin(`import {atom, read, update} from 'claude-code';
    const count = atom({plugin:'fixture', key:'count'}, 0);
    export function register(on) {
      on('command.run', async $ => {
        const before = await read($, count);
        const after = await update($, count, value => value + 1);
        return {before, after, current:await read($, count)};
      });
    }`)
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic:event => { diagnostics.push(event) }})
  try {
    await runtime.reconcile([input])
    expect(diagnostics).toEqual([])
    expect(await runtime.dispatch('command.run', {}, async () => ({}))).toEqual({before:0, after:1, current:1})
  } finally {
    await runtime.dispose()
  }
})

test('concurrent official update helpers retry CAS against the latest value', async () => {
  const input = await plugin(`import {atom, read, update} from 'claude-code';
    const count = atom({plugin:'fixture', key:'count'}, 0);
    export function register(on) {
      on('command.run', async $ => {
        await Promise.all(Array.from({length:4}, () => update($, count, value => value + 1)));
        return {count:await read($, count)};
      });
    }`)
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic:event => { diagnostics.push(event) }})
  try {
    await runtime.reconcile([input])
    expect(await runtime.dispatch('command.run', {}, async () => ({}))).toEqual({count:4})
    expect(diagnostics).toEqual([])
  } finally {
    await runtime.dispose()
  }
})

test('shape changes decline old values and replace them only on update', async () => {
  const source = (shape: string) => `import {atom, read, update} from 'claude-code';
    const count = atom({plugin:'fixture', key:'count'}, 0, {shape:'${shape}'});
    export function register(on) {
      on('command.run', async ($, e) => ({value:e.write ? await update($, count, n => n + 1) : await read($, count), raw:await $.state.get({plugin:'fixture', key:'count'})}));
    }`
  const input = await plugin(source('v1'))
  const runtime = createModsRuntime()
  try {
    await runtime.reconcile([input])
    expect(await runtime.dispatch('command.run', {write:true}, async () => ({}))).toEqual({value:1, raw:{value:{shape:'v1',value:1},version:1}})
    await writeFile(input.entrypoints[0]!, source('v2'))
    await runtime.reconcile([input])
    expect(await runtime.dispatch('command.run', {}, async () => ({}))).toEqual({value:0, raw:{value:{shape:'v1',value:1},version:1}})
    expect(await runtime.dispatch('command.run', {write:true}, async () => ({}))).toEqual({value:1, raw:{value:{shape:'v2',value:1},version:2}})
  } finally {
    await runtime.dispose()
  }
})

test('official update retries across independent concurrent dispatch snapshots', async () => {
  const input = await plugin(`import {atom, update} from 'claude-code';
    const count = atom({plugin:'fixture', key:'count'}, 0);
    export function register(on) {
      on('command.run', async $ => ({count:await update($, count, value => value + 1)}));
    }`)
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic:event => { diagnostics.push(event) }})
  try {
    await runtime.reconcile([input])
    const results = await Promise.all(Array.from({length:4}, () => runtime.dispatch('command.run', {}, async () => ({}))))
    expect(diagnostics).toEqual([])
    expect(results.map(result => (result as {count:number}).count).sort()).toEqual([1,2,3,4])
  } finally {
    await runtime.dispose()
  }
})

test('runs the unmodified official 2.1.287 turn-band fixture', async () => {
  const source = await readFile(new URL('./fixtures/official287-turn-band.tsx.fixture', import.meta.url), 'utf8')
  const input = await plugin('')
  const entry = join(input.pluginRoot, 'register.tsx')
  await writeFile(entry, source)
  input.name = 'turn-band'
  input.entrypoints = [entry]
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic:event => { diagnostics.push(event) }})
  const trees: unknown[] = []
  let drawing = 0
  let hiding = false
  const hidden = Promise.withResolvers<void>()
  try {
    await runtime.bind({cwd:input.pluginRoot, surface:'terminal', isInteractive:true, sessionId:'official'})
    await runtime.reconcile([input])
    expect(diagnostics).toEqual([])
    await runtime.dispatch('prompt.submit', {text:'hello'}, async () => ({text:'hello'}))
    await runtime.dispatch('tool.call', {tool:'Read'}, async () => ({result:'read'}))
    await runtime.dispatch('turn.complete', {text:'done'}, async () => ({text:'done'}))
    const site = await runtime.ui.mount({surface:'terminal', component:'AbovePrompt', requestId:'official-band', props:{hasSurvey:false}}, {
      surface:'terminal', render(tree, revision) {
        trees.push(tree)
        drawing = revision
        if (hiding) hidden.resolve()
      }, unmount() {},
    })
    expect(diagnostics).toEqual([])
    expect(JSON.stringify(trees.at(-1))).toContain('Last turn:')
    expect(JSON.stringify(trees.at(-1))).toContain('Hide')
    const tree = trees.at(-1) as {children: {type:string; press:{plugin:string; handle:number}}[]}
    const button = tree.children.find(child => child.type === 'Button')!
    hiding = true
    await site.interact(drawing, button.press, 'press', 'hide')
    await hidden.promise
    expect(JSON.stringify(trees.at(-1))).not.toContain('Last turn:')
    expect(diagnostics).toEqual([])
  } finally {
    await runtime.dispose()
  }
})

test('runs the unmodified official tool-calls pane through pending and completed calls', async () => {
  const source = await readFile(new URL('./fixtures/official287-tool-calls.tsx.fixture', import.meta.url), 'utf8')
  const input = await plugin('')
  const entry = join(input.pluginRoot, 'register.tsx')
  await writeFile(entry, source)
  input.name = 'tool-calls'
  input.entrypoints = [entry]
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({
    onDiagnostic:event => { diagnostics.push(event) },
    services:{uiPresentation:() => ({columns:160, rows:40, isFullscreen:true, composerEmpty:true, hasDialog:false, keyboardOwned:false})},
  })
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  try {
    await runtime.bind({cwd:input.pluginRoot, surface:'terminal', isInteractive:true, sessionId:'pane'})
    await runtime.reconcile([input])
    await runtime.dispatch('command.run', {command:'tool-calls'}, async () => ({}))
    const pendingFrame = Promise.withResolvers<void>()
    const completedFrame = Promise.withResolvers<void>()
    const unsubscribe = runtime.ui.subscribe(() => {
      const frame = JSON.stringify(runtime.ui.getSnapshot()[0]?.tree)
      if (frame?.includes('runs')) pendingFrame.resolve()
      if (frame?.includes('done')) completedFrame.resolve()
    })
    const running = runtime.dispatch('tool.call', {tool:'Read', tool_use_id:'read-one', input:{}}, async () => {
      entered.resolve()
      await resume.promise
      return {result:'content'}
    })
    await entered.promise
    await pendingFrame.promise
    expect(JSON.stringify(runtime.ui.getSnapshot()[0]?.tree)).toContain('runs')
    resume.resolve()
    await running
    await completedFrame.promise
    unsubscribe()
    expect(JSON.stringify(runtime.ui.getSnapshot()[0]?.tree)).toContain('done')
    expect(JSON.stringify(runtime.ui.getSnapshot()[0]?.tree)).toContain('Read')
    expect(diagnostics).toEqual([])
  } finally {
    resume.resolve()
    await runtime.dispose()
  }
})

test.each([
  `import * as cc from 'claude-code'; export function register(on) { on('command.run', $ => cc.read($, {plugin:'fixture', key:'count'})); }`,
  `import {read} from 'claude-code'; const alias = read; export function register(on) { on('command.run', $ => alias($, {plugin:'fixture', key:'count'})); }`,
  `import {read} from 'claude-code'; export function register(on) { on('command.run', ($, read) => read($, {plugin:'fixture', key:'count'})); }`,
  `import {atom} from 'claude-code'; const count = atom({plugin:'fixture', key:Math.random()}, 0); export function register(on) { on('command.run', () => ({})); }`,
])('rejects unrecognized or dynamic state helper use %#', async source => {
  const input = await plugin(source)
  await expect(loadModDeclaration(input)).rejects.toThrow(/capability escape|literal plugin and key/)
})

test('state helpers do not permit mutation of a plain reference after scanning', async () => {
  const input = await plugin(`import {read} from 'claude-code';
    const reference = {plugin:'fixture', key:'count'};
    reference.key = 'other';
    export function register(on) { on('command.run', $ => read($, reference)); }`)
  await expect(loadModDeclaration(input)).rejects.toThrow(/state reference const/)
})

test('descriptor-only helpers declare reads without invoking state capabilities', async () => {
  const input = await plugin(`import {atom, derive, memberOf} from 'claude-code';
    export const count = atom({plugin:'fixture', key:'count'}, 0);
    export const row = memberOf({plugin:'fixture', key:'rows'}, {requestId:'one'});
    export const total = derive([count, row], (a, b) => a);
    export function register(on) { on('command.run', () => ({})); }`)
  const declaration = await loadModDeclaration(input)
  expect(declaration.calls).toEqual([])
  expect(declaration.state).toEqual({reads:[{plugin:'fixture',key:'count'},{plugin:'fixture',key:'rows'}],writes:[]})
})

test.each(['turn-band', 'tool-calls'])('validates the unmodified official %s manifest state contract', async name => {
  const input = await plugin('')
  await mkdir(join(input.pluginRoot, '.claude-plugin'))
  await mkdir(join(input.pluginRoot, 'hooks'))
  await writeFile(join(input.pluginRoot, '.claude-plugin/plugin.json'), JSON.stringify({name, types:'./types.ts'}))
  await writeFile(join(input.pluginRoot, 'types.ts'), await readFile(new URL(`./fixtures/official287-${name}-types.ts.fixture`, import.meta.url), 'utf8'))
  await writeFile(join(input.pluginRoot, 'hooks/register.tsx'), await readFile(new URL(`./fixtures/official287-${name}.tsx.fixture`, import.meta.url), 'utf8'))
  await writeFile(join(input.pluginRoot, 'hooks/hooks.json'), JSON.stringify({modules:['./register.tsx']}))
  const results = await validatePluginContents(input.pluginRoot)
  expect(results.some(result => result.fileType === 'hooks')).toBe(true)
  expect(results.every(result => result.success)).toBe(true)
  expect(results.flatMap(result => result.errors)).toEqual([])
})

test('manifest types validation checks the scanned state keys', async () => {
  const input = await plugin(`export function register(on) {
    on('command.run', async ($) => $.state.get({plugin:'fixture', key:'missing'}));
  }`)
  await mkdir(join(input.pluginRoot, '.claude-plugin'))
  await mkdir(join(input.pluginRoot, 'hooks'))
  await writeFile(join(input.pluginRoot, '.claude-plugin/plugin.json'), JSON.stringify({name:'fixture', types:'./contract.d.ts'}))
  await writeFile(join(input.pluginRoot, 'contract.d.ts'), `declare module 'claude-code' { interface PluginState { fixture: { count:number } } }`)
  await writeFile(join(input.pluginRoot, 'hooks/hooks.json'), JSON.stringify({modules:['../register.ts']}))
  const results = await validatePluginContents(input.pluginRoot)
  const hooks = results.find(result => result.fileType === 'hooks')!
  expect(hooks.success).toBe(false)
  expect(hooks.errors.some(error => /fixture\.missing.*not declared/.test(error.message))).toBe(true)
})

test('loading a plugin installs the author declarations under its root', async () => {
  const input = await plugin(`export function register(on) { on('command.run', () => ({})); }`)
  const runtime = createModsRuntime()
  try {
    await runtime.reconcile([input])
    expect(await readFile(join(input.pluginRoot, '.claude-plugin/types/claude-code/index.d.ts'), 'utf8'))
      .toContain('export interface PluginState')
  } finally {
    await runtime.dispose()
  }
})

test('state writes expose previous values to middleware and preserve CAS through the VM', async () => {
  const input = await plugin(`export function register(on) {
    on('state.set', ($, e, next) => next({...e, value: e.previous === undefined ? e.value : e.previous + e.value}));
    on('command.run', async ($) => {
      const first = await $.state.set({plugin:'fixture', key:'count'}, 2);
      const second = await $.state.set({plugin:'fixture', key:'count'}, 3, {ifVersion:first.version});
      const lost = await $.state.set({plugin:'fixture', key:'count'}, 99, {ifVersion:first.version});
      return {first, second, lost, current:await $.state.get({plugin:'fixture', key:'count'})};
    });
  }`)
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({ onDiagnostic: event => { diagnostics.push(event) } })
  try {
    await runtime.bind({ cwd:input.pluginRoot, surface:'terminal', isInteractive:true, sessionId:'compatibility' })
    await runtime.reconcile([input])
    expect(await runtime.dispatch('command.run', {}, async () => ({}))).toEqual({
      first: {isSet:true, version:1}, second: {isSet:true, version:2},
      lost: {isSet:false, version:2}, current: {value:5, version:2},
    })
    expect(diagnostics).toEqual([])
  } finally {
    await runtime.dispose()
  }
})

test.each(['plugin', 'key', 'id', 'ifVersion', 'previous'])('state middleware cannot rewrite %s', async field => {
  const input = await plugin(`export function register(on) {
    on('state.set', ($, e, next) => next({...e, ${field}:'forged'}));
    on('command.run', async ($) => {
      const result = await $.state.set({plugin:'fixture', key:'count'}, 7);
      return {result, current:await $.state.get({plugin:'fixture', key:'count'})};
    });
  }`)
  const diagnostics: {message:string}[] = []
  const runtime = createModsRuntime({onDiagnostic:event => { diagnostics.push(event) }})
  try {
    await runtime.reconcile([input])
    const result = await runtime.dispatch('command.run', {}, async () => ({}))
    expect(diagnostics.some(event => /cannot rewrite/.test(event.message))).toBe(true)
    expect(result).toEqual({result:{isSet:true, version:1}, current:{value:7, version:1}})
  } finally {
    await runtime.dispose()
  }
})

test('state family references permit dynamic ids without conflating their values', async () => {
  const input = await plugin(`const family = {plugin:'fixture', key:'rows'};
  export function register(on) {
    on('command.run', async ($, e) => {
      await $.state.set({...family, id:e.id}, e.value);
      return {one:await $.state.get({...family, id:'one'}), two:await $.state.get({...family, id:'two'})};
    });
  }`)
  const runtime = createModsRuntime()
  try {
    await runtime.reconcile([input])
    await runtime.dispatch('command.run', {id:'one', value:1}, async () => ({}))
    expect(await runtime.dispatch('command.run', {id:'two', value:2}, async () => ({}))).toEqual({
      one:{value:1, version:1}, two:{value:2, version:1},
    })
  } finally {
    await runtime.dispose()
  }
})

test.each(['plugin', 'key'])('scanner rejects computed state %s', async field => {
  const input = await plugin(`export function register(on) {
    on('command.run', async ($, e) => $.state.get({plugin:'fixture', key:'rows', ${field}:e.dynamic}));
  }`)
  const diagnostics: {message:string}[] = []
  const runtime = createModsRuntime({onDiagnostic:event => { diagnostics.push(event) }})
  try {
    await runtime.reconcile([input])
    expect(runtime.hasHooks('command.run')).toBe(false)
    expect(diagnostics.some(event => /literal plugin and key/.test(event.message))).toBe(true)
  } finally {
    await runtime.dispose()
  }
})

test('foreign state writes are denied without changing the owner value', async () => {
  const input = await plugin(`export function register(on) {
    on('command.run', async ($) => {
      let denied = false;
      try { await $.state.set({plugin:'other', key:'count'}, 7); } catch { denied = true; }
      return {denied, current:await $.state.get({plugin:'other', key:'count'})};
    });
  }`)
  const runtime = createModsRuntime()
  try {
    await runtime.reconcile([input])
    expect(await runtime.dispatch('command.run', {}, async () => ({}))).toEqual({
      denied:true, current:{value:undefined, version:0},
    })
  } finally {
    await runtime.dispose()
  }
})

test('state writes redraw only subscribed mounted render instances', async () => {
  const input = await plugin(`export function register(on) {
    on('ui.render', async ($, e) => {
      const value = e.requestId === 'reader' ? (await $.state.get({plugin:'fixture', key:'count'})).value : 'independent';
      return $.ui.resolve(e).Text({children:String(value)});
    });
    on('command.run', async ($) => {
      await $.state.set({plugin:'fixture', key:'count'}, 7);
      return {};
    });
  }`)
  const runtime = createModsRuntime()
  const frames: string[] = []
  const trees: unknown[] = []
  const published = Promise.withResolvers<void>()
  let writing = false
  try {
    await runtime.bind({ cwd:input.pluginRoot, surface:'terminal', isInteractive:true, sessionId:'compatibility' })
    await runtime.reconcile([input])
    for (const requestId of ['reader', 'other']) {
      await runtime.ui.mount({ surface:'terminal', component:'AbovePrompt', requestId, props:{} }, {
        surface:'terminal', render(tree) {
          frames.push(requestId)
          trees.push(tree)
          if (writing && requestId === 'reader') published.resolve()
        }, unmount() {},
      })
    }
    frames.length = 0
    writing = true
    await runtime.dispatch('command.run', {}, async () => ({}))
    await published.promise
    expect(frames).toEqual(['reader'])
    expect(JSON.stringify(trees.at(-1))).toContain('7')
  } finally {
    await runtime.dispose()
  }
})

test('unmount forgets state dependencies rather than invalidating a retired site', async () => {
  const input = await plugin(`export function register(on) {
    on('ui.render', async ($, e) => {
      await $.state.get({plugin:'fixture', key:'count'});
      return $.ui.resolve(e).Text({children:'reader'});
    });
    on('command.run', async ($) => $.state.set({plugin:'fixture', key:'count'}, 7));
  }`)
  const runtime = createModsRuntime()
  try {
    await runtime.bind({cwd:input.pluginRoot, surface:'terminal', isInteractive:true, sessionId:'compatibility'})
    await runtime.reconcile([input])
    const site = await runtime.ui.mount({surface:'terminal', component:'AbovePrompt', requestId:'retired', props:{}}, {
      surface:'terminal', render() {}, unmount() {},
    })
    await site.dispose()
    const invalidations: unknown[] = []
    const invalidate = runtime.ui.invalidateInstance
    runtime.ui.invalidateInstance = async instance => { invalidations.push(instance); await invalidate(instance) }
    await runtime.dispatch('command.run', {}, async () => ({}))
    expect(invalidations).toEqual([])
  } finally {
    await runtime.dispose()
  }
})

test('session end resets volatile state while retaining the version floor', async () => {
  const input = await plugin(`export function register(on) {
    on('command.run', async ($, e) => e.write
      ? $.state.set({plugin:'fixture', key:'count'}, 7)
      : $.state.get({plugin:'fixture', key:'count'}));
  }`)
  const runtime = createModsRuntime()
  try {
    await runtime.bind({ cwd:input.pluginRoot, surface:'terminal', isInteractive:true, sessionId:'first' })
    await runtime.reconcile([input])
    expect(await runtime.dispatch('command.run', {write:true}, async () => ({}))).toEqual({isSet:true, version:1})
    await runtime.endSession('other')
    expect(await runtime.dispatch('command.run', {}, async () => ({}))).toEqual({value:undefined, version:0})
    await runtime.bind({ cwd:input.pluginRoot, surface:'terminal', isInteractive:true, sessionId:'second' })
    expect(await runtime.dispatch('command.run', {write:true}, async () => ({}))).toEqual({isSet:true, version:2})
  } finally {
    await runtime.dispose()
  }
})

test('closing the last drawing does not remove dependencies of another live site', async () => {
  const input = await plugin(`export function register(on) {
    on('ui.render', async ($, e) => $.ui.resolve(e).Text({children:String((await $.state.get({plugin:'fixture', key:'count'})).value)}));
    on('command.run', async ($) => $.state.set({plugin:'fixture', key:'count'}, 7));
  }`)
  const runtime = createModsRuntime()
  const updated = Promise.withResolvers<unknown>()
  let writing = false
  try {
    await runtime.bind({cwd:input.pluginRoot, surface:'terminal', isInteractive:true, sessionId:'live'})
    await runtime.reconcile([input])
    const first = await runtime.ui.mount({surface:'terminal', component:'AbovePrompt', requestId:'first', props:{}}, {
      surface:'terminal', render() {}, unmount() {},
    })
    await runtime.ui.mount({surface:'terminal', component:'AbovePrompt', requestId:'second', props:{}}, {
      surface:'terminal', render(tree) { if (writing && JSON.stringify(tree).includes('7')) updated.resolve(tree) }, unmount() {},
    })
    await first.dispose()
    writing = true
    await runtime.dispatch('command.run', {}, async () => ({}))
    expect(JSON.stringify(await updated.promise)).toContain('7')
  } finally {
    await runtime.dispose()
  }
})

test('session-end hook failure still resets state', async () => {
  const input = await plugin(`export function register(on) {
    on('session.end', () => { throw Error('end failure'); });
    on('command.run', async ($, e) => e.write
      ? $.state.set({plugin:'fixture', key:'count'}, 7)
      : $.state.get({plugin:'fixture', key:'count'}));
  }`)
  const diagnostics: {message:string}[] = []
  const runtime = createModsRuntime({onDiagnostic:event => { diagnostics.push(event) }})
  try {
    await runtime.bind({cwd:input.pluginRoot, surface:'terminal', isInteractive:true, sessionId:'failure'})
    await runtime.reconcile([input])
    await runtime.dispatch('command.run', {write:true}, async () => ({}))
    await runtime.endSession('other')
    expect(diagnostics.some(event => event.message.includes('end failure'))).toBe(true)
    expect(await runtime.dispatch('command.run', {}, async () => ({}))).toEqual({value:undefined, version:0})
  } finally {
    await runtime.dispose()
  }
})

test('state persists across plugin reload and replacement render hooks read it', async () => {
  const source = (label: string) => `export function register(on) {
    on('ui.render', async ($, e) => $.ui.resolve(e).Text({children:'${label}:' + (await $.state.get({plugin:'fixture', key:'count'})).value}));
    on('command.run', async ($) => $.state.set({plugin:'fixture', key:'count'}, 7));
  }`
  const input = await plugin(source('before'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic:event => { diagnostics.push(event) }})
  const frames: unknown[] = []
  try {
    await runtime.bind({ cwd:input.pluginRoot, surface:'terminal', isInteractive:true, sessionId:'compatibility' })
    await runtime.reconcile([input])
    await runtime.dispatch('command.run', {}, async () => ({}))
    const site = await runtime.ui.mount({ surface:'terminal', component:'AbovePrompt', requestId:'reload', props:{} }, {
      surface:'terminal', render(tree) { frames.push(tree) }, unmount() {},
    })
    await writeFile(input.entrypoints[0]!, source('after'))
    await runtime.reconcile([input])
    await site.update({ surface:'terminal', component:'AbovePrompt', requestId:'reload', props:{revision:1} })
    expect(diagnostics).toEqual([])
    expect(JSON.stringify(frames.at(-1))).toContain('after:7')
  } finally {
    await runtime.dispose()
  }
})

test('rejects state writes in render without committing their value', async () => {
  const input = await plugin(`export function register(on) {
    on('ui.render', async ($, e) => {
      await $.state.set({plugin:'fixture', key:'count'}, 7);
      return $.ui.resolve(e).Text({children:'invalid'});
    });
    on('command.run', async ($) => $.state.get({plugin:'fixture', key:'count'}));
  }`)
  const diagnostics: {message:string}[] = []
  const runtime = createModsRuntime({ onDiagnostic: event => { diagnostics.push(event) } })
  try {
    await runtime.bind({ cwd:input.pluginRoot, surface:'terminal', isInteractive:true, sessionId:'compatibility' })
    await runtime.reconcile([input])
    await runtime.ui.mount({ surface:'terminal', component:'AbovePrompt', requestId:'pure', props:{} }, {
      surface:'terminal', render() {}, unmount() {},
    })
    expect(diagnostics.some(event => /render.*pure/i.test(event.message))).toBe(true)
    expect(await runtime.dispatch('command.run', {}, async () => ({}))).toEqual({value:undefined, version:0})
  } finally {
    await runtime.dispose()
  }
})

test('invalid toast payload does not consume the plugin throttle window', async () => {
  const input = await plugin(`export function register(on) {
    on('command.run', async ($) => {
      let denied = false;
      try { await $.ui.toast('bad', {timeoutMs:0}); } catch { denied = true; }
      await $.ui.toast('good');
      return {denied};
    });
  }`)
  const shown: unknown[] = []
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({services:{uiToast:(...args) => { shown.push(args) }},onDiagnostic:event => {diagnostics.push(event)}})
  try {
    await runtime.reconcile([input])
    expect(await runtime.dispatch('command.run', {}, async () => ({}))).toEqual({denied:false})
    await runtime.settle()
    expect(shown).toEqual([['fixture', 'good', 4000]])
    expect(diagnostics).toEqual([expect.objectContaining({plugin:'fixture',stage:'async',message:expect.stringContaining('$.ui.toast dropped:')})])
  } finally {
    await runtime.dispose()
  }
})

test('pane placement waits for width and close prevents resize resurrection', async () => {
  const input = await plugin(`export function register(on) {
    on('ui.render', {component:'Pane'}, ($, e) => $.ui.resolve(e).Text({children:'waiting pane'}));
    on('command.run', async ($, e) => {
      if (e.close) { await $.ui.close({id:'waiting'}); return {}; }
      return $.ui.open({id:'waiting',columns:60});
    });
  }`)
  let presentation = {columns:60,rows:24,isFullscreen:true,composerEmpty:true,hasDialog:false,keyboardOwned:false}
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({services:{uiPresentation:() => presentation},onDiagnostic:event => {diagnostics.push(event)}})
  try {
    await runtime.bind({cwd:input.pluginRoot,surface:'terminal',isInteractive:true,sessionId:'placement'})
    await runtime.reconcile([input])
    expect(await runtime.dispatch('command.run', {}, async () => ({}))).toMatchObject({isPlaced:false})
    expect(runtime.ui.getSnapshot()[0]?.visible).toBe(false)
    presentation = {...presentation,columns:160}
    await runtime.ui.render(presentation)
    expect(runtime.ui.getSnapshot()[0]?.visible).toBe(true)
    expect(JSON.stringify(runtime.ui.getSnapshot()[0]?.tree)).toContain('waiting pane')
    await runtime.dispatch('command.run', {close:true}, async () => ({}))
    await runtime.ui.render({...presentation,columns:60})
    await runtime.ui.render(presentation)
    expect(runtime.ui.getSnapshot()).toEqual([])
    expect(diagnostics).toEqual([])
  } finally {
    await runtime.dispose()
  }
})

test('routes toast through scan, VM, middleware and the host with per-plugin throttling', async () => {
  const input = await plugin(`export function register(on) {
    on('ui.toast', ($, e, next) => next({...e, text: 'rewritten:' + e.text}));
    on('command.run', async ($) => {
      await $.ui.toast('first', {timeoutMs: 2500});
      await $.ui.toast('second');
      return {};
    });
  }`)
  const shown: unknown[] = []
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({
    services: { uiToast: (...args) => { shown.push(args) } },
    onDiagnostic: event => { diagnostics.push(event) },
  })
  try {
    await runtime.bind({ cwd:input.pluginRoot, surface:'terminal', isInteractive:true, sessionId:'compatibility' })
    await runtime.reconcile([input])
    await runtime.dispatch('command.run', {}, async () => ({}))
    await runtime.settle()
    expect(diagnostics).toEqual([])
    expect(shown).toEqual([['fixture', 'rewritten:first', 2500]])
  } finally {
    await runtime.dispose()
  }
})
