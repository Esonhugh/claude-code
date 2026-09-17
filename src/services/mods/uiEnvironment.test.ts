import { afterEach, expect, test } from 'bun:test'
import { createModEnvironmentHost, createModUiBridge } from './environment.js'
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
