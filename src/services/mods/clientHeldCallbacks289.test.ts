import { expect, test } from 'bun:test'
import { createModClients, type ModClientRequest } from './client.js'
import { createModClientRealm } from './clientRealm.js'
import { createModUiRealm } from './uiRealm.js'

const node = { type: 'Client', props: { key: 'counter', module: 'counter.ts' }, group: { plugin: 'author' } }
const pane = { owner: {}, id: 'band', visible: true, drawing: 1, tree: node, clock: 'manual' as const }

function fixture() {
  const realm = createModClientRealm(createModUiRealm('author', () => false))
  const presses: number[] = []
  realm.register('counter.ts', (props: any, surface) => {
    if (surface.state === undefined) surface.setState(0)
    if (props?.hidden) return surface.elements.Text({ children: 'hidden' })
    const region = surface.columns
    return surface.elements.Button({ key: 'increment', label: String(surface.state), onPress: () => {
      presses.push(region)
      surface.setState(surface.state + 1)
    } })
  })
  const requests: ModClientRequest[] = [], errors: unknown[] = []
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let tree: any
  const clients = createModClients({
    async request(_pane, _plugin, request) {
      requests.push(request)
      const frame = realm.request(request)
      if (request.op === 'resize') { entered.resolve(); await release.promise }
      return frame
    },
    message: async () => ({}), validate() {},
  })
  const handle = clients.mount(pane, node, value => { tree = value }, error => errors.push(error))
  return { realm, handle, requests, errors, presses, entered, release, tree: () => tree }
}

test('Client press admitted from the visible frame keeps its exact closure through an in-flight region redraw', async () => {
  const f = fixture()
  try {
    await f.handle.ready
    const original = f.tree().press
    const resize = f.handle.resize(24, 1)
    await f.entered.promise
    const press = f.handle.press(original, 'press', 'increment')
    f.release.resolve()
    await resize
    await press
    await f.handle.advance(0)
    expect(f.presses).toEqual([0])
    expect(f.tree().props.label).toBe('1')
    expect(f.requests.filter(request => request.op === 'press').map(request => request.handle)).toEqual([original.handle])
    expect(f.requests.some(request => request.op === 'release' && request.handles?.includes(original.handle))).toBe(true)
    expect(f.errors).toEqual([])
  } finally { f.release.resolve(); await f.handle.dispose(); f.realm.dispose() }
})

test('Client rejects a new call with an old callback after replacement and keeps the current instance usable', async () => {
  const f = fixture()
  try {
    await f.handle.ready
    const original = f.tree().press
    const resize = f.handle.resize(24, 1)
    await f.entered.promise
    f.release.resolve()
    await resize
    await f.handle.settled!()
    await expect(f.handle.press(original, 'press', 'increment')).rejects.toThrow('Client callback is stale')
    expect(f.requests.filter(request => request.op === 'press')).toEqual([])
    await f.handle.press(f.tree().press, 'press', 'increment')
    await f.handle.advance(0)
    expect(f.presses).toEqual([24])
    expect(f.tree().props.label).toBe('1')
    expect(f.errors).toEqual([])
  } finally { f.release.resolve(); await f.handle.dispose(); f.realm.dispose() }
})

test('Client unmount cancels an admitted press before the queued operation reaches the instance', async () => {
  const f = fixture()
  try {
    await f.handle.ready
    const original = f.tree().press
    const resize = f.handle.resize(24, 1)
    await f.entered.promise
    const press = f.handle.press(original, 'press', 'increment')
    const disposal = f.handle.dispose()
    f.release.resolve()
    await resize
    await press
    await disposal
    expect(f.requests.filter(request => request.op === 'press')).toEqual([])
    expect(f.presses).toEqual([])
    expect(f.errors).toEqual([])
    await expect(f.handle.press(original, 'press', 'increment')).rejects.toThrow('Client callback is stale')
  } finally { f.release.resolve(); await f.handle.dispose(); f.realm.dispose() }
})

test('Client realm retains exported closures until the host releases their handles, then revokes them', async () => {
  const f = fixture()
  try {
    await f.handle.ready
    // A separate instance follows the official exportTree / runHeld / dropHeld sequence.
    const first: any = f.realm.request({ op: 'mount', id: 99, module: 'counter.ts' })
    const second: any = f.realm.request({ op: 'resize', id: 99, columns: 24, rows: 1 })
    expect(second.tree.press.handle).not.toBe(first.tree.press.handle)
    f.realm.request({ op: 'press', id: 99, handle: first.tree.press.handle, event: {} })
    expect(f.presses).toEqual([0])
    f.realm.request({ op: 'release', id: 99, handles: [first.tree.press.handle] })
    expect(() => f.realm.request({ op: 'press', id: 99, handle: first.tree.press.handle, event: {} })).toThrow('Client callback is stale')
    expect(f.realm.request({ op: 'press', id: 99, handle: second.tree.press.handle, event: {} })).toEqual({ stopped: true })
  } finally { f.release.resolve(); await f.handle.dispose(); f.realm.dispose() }
})

test('Client replacing the control with text revokes later admission without invoking a removed closure', async () => {
  const f = fixture()
  try {
    await f.handle.ready
    const original = f.tree().press
    const hidden = { ...node, props: { ...node.props, props: { hidden: true } } }
    await f.handle.update({ ...pane, drawing: 2, tree: hidden }, hidden)
    await f.handle.settled!()
    expect(f.tree()).toMatchObject({ type: 'Text', children: ['hidden'] })
    await expect(f.handle.press(original, 'press', 'increment')).rejects.toThrow('Client callback is stale')
    expect(f.requests.filter(request => request.op === 'press')).toEqual([])
    expect(f.presses).toEqual([])
    expect(f.errors).toEqual([])
  } finally { f.release.resolve(); await f.handle.dispose(); f.realm.dispose() }
})

test('Client repeated published replacements release every previous callback and keep the final callback live', async () => {
  const f = fixture()
  try {
    await f.handle.ready
    const previous: number[] = []
    for (let index = 0; index < 32; index++) {
      previous.push(f.tree().press.handle)
      await f.handle.update({ ...pane, drawing: index + 2 }, node)
      await f.handle.settled!()
    }
    const released = f.requests.filter(request => request.op === 'release').flatMap(request => request.handles ?? [])
    expect(released).toEqual(previous)
    expect(new Set(released).size).toBe(32)
    expect(released).not.toContain(f.tree().press.handle)
    await f.handle.press(f.tree().press, 'press', 'increment')
    await f.handle.advance(0)
    expect(f.presses).toEqual([0])
    expect(f.tree().props.label).toBe('1')
    expect(f.errors).toEqual([])
  } finally { f.release.resolve(); await f.handle.dispose(); f.realm.dispose() }
})
