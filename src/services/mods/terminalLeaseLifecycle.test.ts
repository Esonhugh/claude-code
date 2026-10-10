import { expect, test } from 'bun:test'
import { createModClients, type ModClientRequest, type ModClients, type ModClientSite } from './client.js'
import { createModEnvironmentHost, type ModEnvironment } from './environment.js'
import type { ModTerminalClientHandle } from './terminalClient.js'
import type { ModDeclaration } from './types.js'

const size = () => ({ columns: 100, rows: 30, conversationColumns: 100 })
const node = (module: string, key = 'surface') => ({
  type: 'Client' as const, group: { plugin: 'owner' }, props: { key, module },
})

async function fixture(run: (input: {
  clients: ModClients
  environment: ModEnvironment
  pane: ModClientSite
  handles: ModTerminalClientHandle[]
  requests: ModClientRequest[]
  acquire(module: string, key?: string): Promise<ModTerminalClientHandle>
}) => Promise<void>) {
  const host = createModEnvironmentHost()
  const handles: ModTerminalClientHandle[] = []
  const requests: ModClientRequest[] = []
  const modules = ['a.js', 'b.js', 'c.js']
  const declaration: ModDeclaration = {
    name: 'owner', storageId: 'owner@test', pluginRoot: '/fixture', tier: 'user',
    options: {}, fingerprint: 'terminal-client-registry', entrypoints: ['/fixture/register.js'],
    events: ['tool.call'], calls: [], nextTiers: [], links: [],
    clients: modules.map(module => ({ path: '/fixture/' + module, module })),
    modules: [
      { path: '/fixture/register.js', source: "export function register(on) { on('tool.call', () => 'hooks alive') }" },
      ...modules.map(module => ({ path: '/fixture/' + module, source: `export default function Surface(_, s) {
        if (s.state === undefined) { s.setState(0); s.onKey(() => s.setState(s.state + 1)); }
        return s.elements.Text({ children: '${module}:' + s.state });
      }` })),
    ],
  }
  try {
    const environment = await host.load(declaration)
    const clients = createModClients({
      async request(_site, _plugin, request) {
        requests.push(request)
        return environment.client(request)
      },
      message: async () => ({}), validate() {},
    })
    const pane: ModClientSite = {
      owner: {}, id: 'band', visible: true, surface: 'terminal', component: 'AbovePrompt', clock: 'manual', drawing: 1,
    }
    const acquire = async (module: string, key?: string) => {
      const tree = node(module, key)
      const handle = clients.acquire!({ ...pane, tree }, tree, () => {}, size)
      handles.push(handle)
      await handle.ready
      return handle
    }
    await run({ clients, environment, pane, handles, requests, acquire })
  } finally {
    await Promise.all(handles.map(handle => handle.dispose()))
    await host.dispose()
  }
}

function drawn(handle: ModTerminalClientHandle) {
  const snapshot = handle.getSnapshot()
  expect(snapshot.status).toBe('drawn')
  return snapshot.status === 'drawn' ? snapshot.tree : undefined
}

test('same-key module replacement remains reachable when the last terminal Client owner closes', async () => fixture(async ({ acquire, clients, environment, handles, requests }) => {
  const original = await acquire('a.js')
  const retained = original.retain(size)
  handles.push(retained)
  const current = await acquire('b.js')
  expect(drawn(current)).toMatchObject({ type: 'Text', children: ['b.js:0'] })
  await original.dispose()
  await retained.dispose()

  clients.reconcile([])
  expect(() => { handles.push(current.retain(size)) }).toThrow('stale')
  await expect(current.key({ key: 'closed' })).rejects.toThrow('stale')
  await current.dispose()
  const mounted = requests.filter(request => request.op === 'mount')
  expect(mounted.map(request => request.module)).toEqual(['a.js', 'b.js'])
  for (const { id } of mounted) expect(await environment.client({ op: 'frame', id, now: 1 })).toEqual({ stopped: true })
  expect(await environment.invoke(environment.registrations[0]!.id, [])).toBe('hooks alive')
}))

test('plugin invalidation finds a replacement terminal Client and remounts fresh Worker state', async () => fixture(async ({ acquire, clients, environment, pane, handles, requests }) => {
  const original = await acquire('a.js')
  handles.push(original.retain(size))
  const current = await acquire('b.js')
  await current.key({ key: 'increment' })
  await current.settled!()
  expect(drawn(current)).toMatchObject({ children: ['b.js:1'] })
  const oldId = requests.filter(request => request.op === 'mount').at(-1)!.id

  clients.invalidatePlugin!('owner')
  expect(current.getSnapshot().status).toBe('loading')
  const tree = node('b.js')
  await current.update({ ...pane, tree, drawing: 2 }, tree)
  await current.ready
  expect(drawn(current)).toMatchObject({ children: ['b.js:0'] })
  expect(requests.filter(request => request.op === 'mount').map(request => request.module)).toEqual(['a.js', 'b.js', 'b.js'])
  expect(await environment.client({ op: 'frame', id: oldId, now: 1 })).toEqual({ stopped: true })
  await expect(original.key({ key: 'obsolete' })).rejects.toThrow('stale')
  await current.key({ key: 'increment' })
  await current.settled!()
  expect(drawn(current)).toMatchObject({ children: ['b.js:1'] })
}))

test('same-owner sibling survives module replacement and all current leases retire on close', async () => fixture(async ({ acquire, clients, environment, pane, handles, requests }) => {
  const sibling = await acquire('c.js', 'sibling')
  const original = await acquire('a.js')
  handles.push(original.retain(size))
  const current = await acquire('b.js')
  const tree = { type: 'Box', children: [node('c.js', 'sibling'), node('b.js')] }
  clients.reconcile([{ ...pane, tree }])
  await original.dispose()
  await sibling.key({ key: 'increment' })
  await sibling.settled!()
  await current.key({ key: 'increment' })
  await current.settled!()
  expect(drawn(sibling)).toMatchObject({ children: ['c.js:1'] })
  expect(drawn(current)).toMatchObject({ children: ['b.js:1'] })

  clients.reconcile([])
  for (const handle of [sibling, current]) {
    expect(() => { handles.push(handle.retain(size)) }).toThrow('stale')
    await handle.dispose()
  }
  const mounted = requests.filter(request => request.op === 'mount')
  expect(mounted.map(request => request.module)).toEqual(['c.js', 'a.js', 'b.js'])
  for (const { id } of mounted) expect(await environment.client({ op: 'frame', id, now: 1 })).toEqual({ stopped: true })
}))

test('terminal holder handoff retains Worker state and final release alone creates a fresh instance', async () => fixture(async ({ acquire, handles, requests }) => {
  const first = await acquire('a.js')
  await first.key({ key: 'increment' })
  await first.settled!()
  expect(drawn(first)).toMatchObject({ children: ['a.js:1'] })
  const retained = first.retain(size)
  handles.push(retained)
  await first.dispose()
  await expect(first.key({ key: 'retired' })).rejects.toThrow('stale')
  expect(drawn(retained)).toMatchObject({ children: ['a.js:1'] })
  const handoff = await acquire('a.js')
  await retained.dispose()
  expect(drawn(handoff)).toMatchObject({ children: ['a.js:1'] })
  const releasing = handoff.dispose()
  const immediate = await acquire('a.js')
  await releasing
  expect(drawn(immediate)).toMatchObject({ children: ['a.js:1'] })
  expect(requests.filter(request => request.op === 'mount')).toHaveLength(1)
  await immediate.dispose()
  const fresh = await acquire('a.js')
  expect(drawn(fresh)).toMatchObject({ children: ['a.js:0'] })
  expect(requests.filter(request => request.op === 'mount')).toHaveLength(2)
}))
