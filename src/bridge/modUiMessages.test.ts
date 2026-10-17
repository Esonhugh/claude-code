import { expect, test } from 'bun:test'
import { BoundedUUIDSet, handleIngressMessage } from './bridgeMessaging.js'
import { isModUiInboundEvent, materializeModUiTree } from './modUiMessages.js'

const attach = {
  type: 'mod_ui',
  subtype: 'attach',
  client_id: 'desktop-1',
  surface: 'desktop',
  input: {
    surface: 'desktop',
    component: 'PromptHint',
    requestId: 'hint',
    props: { text: 'ready' },
    viewport: { columns: 90, rows: 30 },
  },
} as const

test('validates dedicated mod_ui inbound events outside the SDK transcript union', () => {
  expect(isModUiInboundEvent(attach)).toBe(true)
  expect(isModUiInboundEvent({ ...attach, surface: 'terminal' })).toBe(false)
  expect(isModUiInboundEvent({ ...attach, client_id: '' })).toBe(false)
  expect(isModUiInboundEvent({ ...attach, input: { ...attach.input, props: [] } })).toBe(false)
  expect(isModUiInboundEvent({
    type: 'mod_ui', subtype: 'interact', client_id: 'desktop-1', drawing: 1,
    callback: { plugin: 'owner', handle: 2 }, kind: 'press', element: 'run',
  })).toBe(true)
  expect(isModUiInboundEvent({
    type: 'mod_ui', subtype: 'interact', client_id: 'desktop-1', drawing: 1,
    callback: { plugin: 'owner', handle: 2 }, kind: 'input.change', element: 'query',
  })).toBe(false)
  expect(isModUiInboundEvent({ type: 'mod_ui', subtype: 'detach', client_id: 'desktop-1' })).toBe(true)
})

test('validates every remote surface and materializes engine refs into JSON-safe data', () => {
  for (const surface of ['desktop', 'mobile', 'vscode'] as const) {
    expect(isModUiInboundEvent({
      ...attach,
      surface,
      input: { ...attach.input, surface },
    })).toBe(true)
  }
  const tree = materializeModUiTree(
    { type: 'Box', children: [{ type: 'engine', ref: 0 }] },
    ref => ({ text: ref === 0 ? 'fallback' : 'wrong' }),
  )
  expect(tree).toEqual({ type: 'Box', children: [{ text: 'fallback' }] })
  expect(() => materializeModUiTree({ bad: () => {} }, () => ({}))).toThrow(/JSON-safe/)
})

test('contains rejected asynchronous mod_ui handlers', async () => {
  const rejection = new Error('remote client is not attached')
  const unhandled = Promise.withResolvers<unknown>()
  const listener = (reason: unknown) => unhandled.resolve(reason)
  process.once('unhandledRejection', listener)
  try {
    handleIngressMessage(
      JSON.stringify(attach),
      new BoundedUUIDSet(8),
      new BoundedUUIDSet(8),
      undefined,
      undefined,
      undefined,
      async () => { throw rejection },
    )
    expect(await Promise.race([
      unhandled.promise,
      new Promise(resolve => setImmediate(() => resolve('contained'))),
    ])).toBe('contained')
  } finally {
    process.off('unhandledRejection', listener)
  }
})

test('routes mod_ui before SDK user UUID echo dedup and prompt analytics routing', () => {
  const posted = new BoundedUUIDSet(8)
  const inbound = new BoundedUUIDSet(8)
  posted.add('echo')
  const ui: unknown[] = []
  const prompts: unknown[] = []
  handleIngressMessage(
    JSON.stringify({ ...attach, uuid: 'echo' }),
    posted,
    inbound,
    message => { prompts.push(message) },
    undefined,
    undefined,
    event => { ui.push(event) },
  )
  expect(ui).toEqual([{ ...attach, uuid: 'echo' }])
  expect(prompts).toEqual([])
  expect(inbound.has('echo')).toBe(false)
})
