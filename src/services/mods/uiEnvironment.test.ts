import { afterEach, expect, test } from 'bun:test'
import { createModEnvironmentHost, createModUiBridge, createModUiCoreTable } from './environment.js'
import type { ModDeclaration } from './types.js'

const hosts: ReturnType<typeof createModEnvironmentHost>[] = []
afterEach(async () => { await Promise.all(hosts.splice(0).map(host => host.dispose())) })

async function fixture(source: string) {
  const host = createModEnvironmentHost()
  hosts.push(host)
  const declaration: ModDeclaration = {
    name: 'ui-owner', storageId: 'ui-owner@test', pluginRoot: '/fixture',
    entrypoints: ['/fixture/main.js'], modules: [{ path: '/fixture/main.js', source }],
    links: [], events: ['ui.render'], calls: ['ui.resolve', 'ui.status'], nextTiers: [],
    options: {}, tier: 'user', fingerprint: source,
  }
  const environment = await host.load(declaration)
  return { environment, handle: environment.registrations[0]!.id }
}

const event = { surface: 'terminal', component: 'Pane', requestId: 'test' }

test('drawing materialization rejects proxies and accessors before they can call host capabilities', async () => {
  for (const tree of [
    `({type:'Box', get children() { $.ui.status('getter'); return []; }})`,
    `new Proxy({type:'Box'}, {get(target,key) { $.ui.status('proxy'); return target[key]; }})`,
    `({type:'Box', children:[new Proxy({type:'Text'}, {ownKeys() { $.ui.status('nested'); return []; }})]})`,
  ]) {
    const { environment, handle } = await fixture(`export function register(on) {
      on('ui.render', ($, e) => ${tree});
    }`)
    const statuses: unknown[] = []
    const ui = createModUiBridge({ status: value => { statuses.push(value) } })
    const failure = await environment.invoke(handle, [{ ui }, event], undefined, 1).then(() => null, error => error)
    expect(failure).toBeInstanceOf(Error)
    expect(statuses).toEqual([])
  }
})

test('cyclic drawing children fail without allocating unreleasable callbacks', async () => {
  const { environment, handle } = await fixture(`export function register(on) {
    on('ui.render', ($, e) => {
      const tree = {type:'Box', children:[]}; tree.children.push(tree); return tree;
    });
  }`)
  const failure = await environment.invoke(handle, [{ ui: createModUiBridge({}) }, event], undefined, 1).then(() => null, error => error)
  expect(failure.message).toContain('Cyclic UI drawing')
})

test('drawing callbacks cannot invoke registration handles or another drawing lease', async () => {
  const { environment, handle } = await fixture(`export function register(on) {
    on('ui.render', ($, e) => $.ui.resolve(e).Button({label:'safe', onPress:() => $.ui.status('clicked')}));
  }`)
  const statuses: unknown[] = []
  const ui = createModUiBridge({ status: value => { statuses.push(value) } })
  const first = await environment.invoke(handle, [{ ui }, event], undefined, 1) as any
  const second = await environment.invoke(handle, [{ ui }, event], undefined, 2) as any
  for (const forged of [handle, second.press.handle]) {
    const failure = await environment.invokeDrawing(1, forged, [{}]).then(() => null, error => error)
    expect(failure.message).toContain('Unknown drawing callback')
  }
  await environment.invokeDrawing(1, first.press.handle, [{}])
  expect(statuses).toEqual(['clicked'])
  await environment.releaseDrawing(1)
  const failure = await environment.invokeDrawing(1, first.press.handle, [{}]).then(() => null, error => error)
  expect(failure.message).toContain('Unknown drawing callback')
})

test('real Worker provides synchronous constructors and drawing-owned callback handles', async () => {
  const { environment, handle } = await fixture(`export function register(on) {
    on('ui.render', ($, e) => {
      const { Box, Button } = $.ui.resolve(e);
      return h(Box, {}, h(Button, {label:'press', onPress:() => $.ui.status('clicked')}));
    });
  }`)
  const statuses: unknown[] = []
  const ui = createModUiBridge({ status: value => { statuses.push(value) } })
  const tree = await environment.invoke(handle, [{ ui }, event], undefined, 1) as any
  const press = tree.children[0].press
  expect(press.plugin).toBe('ui-owner')
  expect(press.handle).toBeGreaterThan(0)
  await environment.invoke(press.handle, [{ element: 'press' }])
  expect(statuses).toEqual(['clicked'])
  await environment.releaseDrawing(1)
  const failure = await environment.invoke(press.handle, [{}]).then(() => null, error => error)
  expect(failure).toBeInstanceOf(Error)
  expect(failure.message).toContain('Unknown or unloaded')
})

test('redrawing a cached tree allocates a new drawing lease; releasing old handles leaves new ones live', async () => {
  const { environment, handle } = await fixture(`let cached;
    export function register(on) {on('ui.render', ($, e) => {
      const { Button } = $.ui.resolve(e);
      cached ??= Button({label:'same', onPress:() => $.ui.status('live')});
      return cached;
    });}
  `)
  const statuses: unknown[] = []
  const ui = createModUiBridge({ status: value => { statuses.push(value) } })
  const first = await environment.invoke(handle, [{ ui }, event], undefined, 1) as any
  const second = await environment.invoke(handle, [{ ui }, event], undefined, 2) as any
  expect(first.press.handle).not.toBe(second.press.handle)
  await environment.releaseDrawing(1)
  await environment.invoke(second.press.handle, [{}])
  expect(statuses).toEqual(['live'])
  const oldFailure = await environment.invoke(first.press.handle, [{}]).then(() => null, error => error)
  expect(oldFailure.message).toContain('Unknown or unloaded')
  await environment.releaseDrawing(2)
  const failure = await environment.invoke(second.press.handle, [{}]).then(() => null, error => error)
  expect(failure.message).toContain('Unknown or unloaded')
})

test('real Worker exposes Svg only on remote surfaces and keeps it frozen serializable data', async () => {
  const { environment, handle } = await fixture(`export function register(on) {
    on('ui.render', ($, e) => {
      const elements = $.ui.resolve(e);
      if (!elements.Svg) return {hasSvg:false};
      const tree = elements.Svg({source:'<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>',alt:'dot',width:20,height:10,isInteractive:false});
      return {hasSvg:true,tree,frozen:Object.isFrozen(tree)&&Object.isFrozen(tree.props),json:JSON.stringify(tree)};
    });
  }`)
  const ui = createModUiBridge({})
  for (const surface of ['desktop', 'mobile', 'vscode']) {
    const result = await environment.invoke(handle, [{ ui }, {...event, surface}], undefined, surface.length) as any
    expect(result.hasSvg).toBe(true)
    expect(result.tree).toEqual({type:'Svg',props:{source:'<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>',alt:'dot',width:20,height:10,isInteractive:false}})
    expect(result.frozen).toBe(true)
    expect(JSON.parse(result.json)).toEqual(result.tree)
  }
  expect(await environment.invoke(handle, [{ ui }, event], undefined, 100)).toEqual({hasSvg:false})
})

test('decorated constructors preserve callback ownership across provider environments', async () => {
  const host = createModEnvironmentHost()
  hosts.push(host)
  const provider = await host.load({
    name: 'provider', storageId: 'provider-callback@test', pluginRoot: '/fixture',
    entrypoints: ['/fixture/provider-callback.js'], modules: [{ path: '/fixture/provider-callback.js', source: `export function register(on) {
      on('ui.resolve', async ($, e, next) => { const elements = await next(e); return {...elements, Button: props => elements.Button({...props,label:'decorated'})}; });
    }` }],
    links: [], events: ['ui.resolve'], calls: [], nextTiers: [], options: {}, tier: 'user', fingerprint: 'provider-callback',
  })
  const consumer = await host.load({
    name: 'consumer', storageId: 'consumer-callback@test', pluginRoot: '/fixture',
    entrypoints: ['/fixture/consumer-callback.js'], modules: [{ path: '/fixture/consumer-callback.js', source: `let saved; export function register(on) {
      on('ui.render', ($, e) => { saved ??= $.ui.resolve(e).Button; return saved({key:'run',label:'plain',onPress:() => $.ui.status('clicked')}); });
    }` }],
    links: [], events: ['ui.render'], calls: ['ui.resolve', 'ui.status'], nextTiers: [], options: {}, tier: 'user', fingerprint: 'consumer-callback',
  })
  const core = createModUiCoreTable('terminal', 'Pane')
  const next = Object.assign(async () => core, {
    to: async () => core, is: () => false, signal: new AbortController().signal,
    event: 'ui.resolve', origin: { plugin: 'engine', tier: 'core' as const }, trace: [],
    budget: { ms: 0, remainingMs: Infinity },
  })
  const table = await provider.invoke(provider.registrations[0]!.id, [{}, { surface: 'terminal', component: 'Pane' }], next) as object
  const publish = await host.prepareUiTables(new Map([[consumer, new Map([['terminal:Pane', table]])]]), [consumer])
  await publish()
  const statuses: unknown[] = []
  const ui = createModUiBridge({ status: value => { statuses.push(value) } })
  const tree = await consumer.invoke(consumer.registrations[0]!.id, [{ ui }, event], undefined, 1) as any
  expect(tree.props.label).toBe('decorated')
  expect(tree.press.plugin).toBe('provider')
  await provider.invokeDrawing(1, tree.press.handle, [{}])
  expect(statuses).toEqual(['clicked'])

  const revoke = await host.prepareUiTables(new Map([[consumer, new Map([['terminal:Pane', core]])]]), [])
  await revoke()
  const staleFailure = await consumer.invoke(consumer.registrations[0]!.id, [{ ui }, event], undefined, 2).then(() => null, error => error)
  expect(staleFailure.message).toContain('withdrawn')
  await consumer.releaseDrawing(1)
  const releasedFailure = await provider.invokeDrawing(1, tree.press.handle, [{}]).then(() => null, error => error)
  expect(releasedFailure.message).toContain('withdrawn')
})

test('published UI table constructors are revoked by the next publication', async () => {
  const host = createModEnvironmentHost()
  hosts.push(host)
  const provider = await host.load({
    name: 'provider', storageId: 'provider@test', pluginRoot: '/fixture',
    entrypoints: ['/fixture/provider.js'], modules: [{ path: '/fixture/provider.js', source: `export function register(on) {
      on('ui.resolve', async ($, e, next) => ({...(await next(e)), Text: props => ({type:'Text', props:{...props, generation:'old'}})}));
    }` }],
    links: [], events: ['ui.resolve'], calls: [], nextTiers: [], options: {}, tier: 'user', fingerprint: 'provider',
  })
  const consumer = await host.load({
    name: 'consumer', storageId: 'consumer@test', pluginRoot: '/fixture',
    entrypoints: ['/fixture/consumer.js'], modules: [{ path: '/fixture/consumer.js', source: `let saved; export function register(on) {
      on('ui.render', ($, e) => { saved ??= $.ui.resolve(e).Text; return saved({children:'value'}); });
    }` }],
    links: [], events: ['ui.render'], calls: ['ui.resolve'], nextTiers: [], options: {}, tier: 'user', fingerprint: 'consumer',
  })
  const providerHandle = provider.registrations[0]!.id
  const consumerHandle = consumer.registrations[0]!.id
  const core = createModUiCoreTable('terminal', 'Pane')
  const next = Object.assign(async () => core, {
    to: async () => core, is: () => false, signal: new AbortController().signal,
    event: 'ui.resolve', origin: { plugin: 'engine', tier: 'core' as const }, trace: [],
    budget: { ms: 0, remainingMs: Infinity },
  })
  const table = await provider.invoke(providerHandle, [{}, { surface: 'terminal', component: 'Pane' }], next) as object
  const publish = await host.prepareUiTables(new Map([[consumer, new Map([['terminal:Pane', table]])]]), [consumer])
  await publish()
  const ui = createModUiBridge({})
  expect(await consumer.invoke(consumerHandle, [{ ui }, event])).toMatchObject({ props: { generation: 'old' } })

  const revoke = await host.prepareUiTables(new Map([[consumer, new Map([['terminal:Pane', core]])]]), [])
  await revoke()
  const failure = await consumer.invoke(consumerHandle, [{ ui }, event]).then(() => null, error => error)
  expect(failure.message).toContain('withdrawn')
})

test('preparing a replacement withdraws abandoned staged constructor grants', async () => {
  const host = createModEnvironmentHost()
  hosts.push(host)
  const provider = await host.load({
    name: 'provider', storageId: 'provider-staged@test', pluginRoot: '/fixture',
    entrypoints: ['/fixture/provider-staged.js'], modules: [{ path: '/fixture/provider-staged.js', source: `export function register(on) {
      on('ui.resolve', async ($, e, next) => ({...(await next(e)), Text: props => ({type:'Text', props})}));
    }` }],
    links: [], events: ['ui.resolve'], calls: [], nextTiers: [], options: {}, tier: 'user', fingerprint: 'provider-staged',
  })
  const consumer = await host.load({
    name: 'consumer', storageId: 'consumer-staged@test', pluginRoot: '/fixture',
    entrypoints: ['/fixture/consumer-staged.js'], modules: [{ path: '/fixture/consumer-staged.js', source: `let saved; export function register(on) {
      on('ui.render', ($, e) => { saved ??= $.ui.resolve(e).Text; return saved({children:'value'}); });
    }` }],
    links: [], events: ['ui.render'], calls: ['ui.resolve'], nextTiers: [], options: {}, tier: 'user', fingerprint: 'consumer-staged',
  })
  const core = createModUiCoreTable('terminal', 'Pane')
  const next = Object.assign(async () => core, {
    to: async () => core, is: () => false, signal: new AbortController().signal,
    event: 'ui.resolve', origin: { plugin: 'engine', tier: 'core' as const }, trace: [],
    budget: { ms: 0, remainingMs: Infinity },
  })
  const table = await provider.invoke(provider.registrations[0]!.id, [{}, { surface: 'terminal', component: 'Pane' }], next) as object
  await host.prepareUiTables(new Map([[consumer, new Map([['terminal:Pane', table]])]]), [consumer])
  const ui = createModUiBridge({})
  await consumer.invoke(consumer.registrations[0]!.id, [{ ui }, event])

  await host.prepareUiTables(new Map([[consumer, new Map([['terminal:Pane', core]])]]), [consumer])
  const failure = await consumer.invoke(consumer.registrations[0]!.id, [{ ui }, event]).then(() => null, error => error)
  expect(failure.message).toContain('withdrawn')
})

test('retiring a UI table provider revokes captured constructors before its environment is reused', async () => {
  const host = createModEnvironmentHost()
  hosts.push(host)
  const provider = await host.load({
    name: 'provider', storageId: 'provider-retire@test', pluginRoot: '/fixture',
    entrypoints: ['/fixture/provider-retire.js'], modules: [{ path: '/fixture/provider-retire.js', source: `export function register(on) {
      on('ui.resolve', async ($, e, next) => ({...(await next(e)), Text: props => ({type:'Text', props})}));
    }` }],
    links: [], events: ['ui.resolve'], calls: [], nextTiers: [], options: {}, tier: 'user', fingerprint: 'provider-retire',
  })
  const consumer = await host.load({
    name: 'consumer', storageId: 'consumer-retire@test', pluginRoot: '/fixture',
    entrypoints: ['/fixture/consumer-retire.js'], modules: [{ path: '/fixture/consumer-retire.js', source: `let saved; export function register(on) {
      on('ui.render', ($, e) => { saved ??= $.ui.resolve(e).Text; return saved({children:'value'}); });
    }` }],
    links: [], events: ['ui.render'], calls: ['ui.resolve'], nextTiers: [], options: {}, tier: 'user', fingerprint: 'consumer-retire',
  })
  const core = createModUiCoreTable('terminal', 'Pane')
  const next = Object.assign(async () => core, {
    to: async () => core, is: () => false, signal: new AbortController().signal,
    event: 'ui.resolve', origin: { plugin: 'engine', tier: 'core' as const }, trace: [],
    budget: { ms: 0, remainingMs: Infinity },
  })
  const table = await provider.invoke(provider.registrations[0]!.id, [{}, { surface: 'terminal', component: 'Pane' }], next) as object
  const publish = await host.prepareUiTables(new Map([[consumer, new Map([['terminal:Pane', table]])]]), [consumer])
  await publish()
  const ui = createModUiBridge({})
  await consumer.invoke(consumer.registrations[0]!.id, [{ ui }, event])

  await provider.dispose()
  const failure = await consumer.invoke(consumer.registrations[0]!.id, [{ ui }, event]).then(() => null, error => error)
  expect(failure.message).toContain('withdrawn')
})

test('replacing a UI table consumer revokes constructors captured by its retained environment', async () => {
  const host = createModEnvironmentHost()
  hosts.push(host)
  const consumerSource = `let saved; export function register(on) {
    on('ui.render', ($, e) => { saved ??= $.ui.resolve(e).Text; return saved({children:'value'}); });
  }`
  const declaration = (name: string, source = consumerSource, events = ['ui.render']): ModDeclaration => ({
    name, storageId: `${name}@test`, pluginRoot: '/fixture',
    entrypoints: [`/fixture/${name}.js`], modules: [{ path: `/fixture/${name}.js`, source }],
    links: [], events, calls: ['ui.resolve'], nextTiers: [], options: {}, tier: 'user', fingerprint: name,
  })
  const provider = await host.load(declaration('consumer-provider', `export function register(on) {
    on('ui.render', () => null);
    on('ui.resolve', async ($, e, next) => ({...(await next(e)), Text: props => ({type:'Text', props})}));
  }`, ['ui.render', 'ui.resolve']))
  const oldConsumer = await host.load(declaration('old-consumer'))
  const newConsumer = await host.load(declaration('new-consumer'))
  const core = createModUiCoreTable('terminal', 'Pane')
  const next = Object.assign(async () => core, {
    to: async () => core, is: () => false, signal: new AbortController().signal,
    event: 'ui.resolve', origin: { plugin: 'engine', tier: 'core' as const }, trace: [],
    budget: { ms: 0, remainingMs: Infinity },
  })
  const table = await provider.invoke(provider.registrations[1]!.id, [{}, { surface: 'terminal', component: 'Pane' }], next) as object
  const publishOld = await host.prepareUiTables(new Map([[oldConsumer, new Map([['terminal:Pane', table]])]]), [oldConsumer])
  await publishOld()
  const ui = createModUiBridge({})
  await oldConsumer.invoke(oldConsumer.registrations[0]!.id, [{ ui }, event])

  const publishNew = await host.prepareUiTables(new Map([[newConsumer, new Map([['terminal:Pane', table]])]]), [newConsumer])
  await publishNew()
  const failure = await oldConsumer.invoke(oldConsumer.registrations[0]!.id, [{ ui }, event]).then(() => null, error => error)
  expect(failure.message).toContain('withdrawn')
  expect(await newConsumer.invoke(newConsumer.registrations[0]!.id, [{ ui }, event])).toMatchObject({ type: 'Text' })
})

test('revoked UI resolve cannot be used from a captured bridge on a later invocation', async () => {
  const { environment, handle } = await fixture(`let saved;
    export function register(on) {on('ui.render', ($, e) => {
      saved ??= $.ui; return saved.resolve(e).Text({children:'allowed'});
    });}
  `)
  const ui = createModUiBridge({})
  await environment.invoke(handle, [{ ui }, event], undefined, 1)
  await environment.setUiAccess(false)
  const failure = await environment.invoke(handle, [{ ui }, event], undefined, 2).then(() => null, error => error)
  expect(failure.message).toContain('withdrawn')
  await environment.releaseDrawing(1)
})
