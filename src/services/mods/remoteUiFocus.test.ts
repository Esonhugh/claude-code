import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime, type ModsRuntime } from './runtime.js'
import { createModRemoteUIControl } from './remoteUiControl.js'
import { SDKMessageSchema } from '../../entrypoints/sdk/coreSchemas.js'
import type { SDKControlRequest } from '../../entrypoints/sdk/controlTypes.js'
let root: string
const runtimes: ModsRuntime[] = []
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'mods-remote-focus-'))) })
afterEach(async () => { await Promise.all(runtimes.splice(0).map(r => r.dispose())); await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const diagnostics: unknown[] = [], events: any[] = [], messages: any[] = [], replies = new Map<string, any>()
  const runtime = createModsRuntime({ onDiagnostic: error => diagnostics.push(error) }); runtimes.push(runtime)
  await runtime.bind({ cwd: root, sessionId: 'focus', surface: null, isInteractive: false })
  await writeFile(join(root,'surface.ts'), 'export default function(){return null}')
  const entry = join(root, 'owner.ts')
  await writeFile(entry, `export function register(on){
    on('session.start',async($,e,next)=>{await $.ui.open({id:'alpha'});return next(e)});
    on('tool.call',async($,e)=>({result:await $.ui.focus(e.input)}));
    on('ui.focus',async($,e,next)=>{if(e.element==='denied')return {deny:'keep it'};if(e.element==='failed')throw Error('focus failure');if(e.element==='rewrite')return next({element:'one'});if(e.element==='readonly')return next({...e,plugin:'spoof'});if(e.element==='invalid-deny')return {deny:''};if(e.element==='deny-after-next'){await next({...e,element:'one'});return {deny:'too late'}};if(e.element==='held')await $.clock.sleep(80);return next(e)});
    on('ui.render',{component:'Pane'},($,e)=>{const ui=$.ui.resolve(e);if(e.props.empty)return ui.Text({children:'no focusables'});if(e.props.client)return ui.Client({key:'client',module:'./surface.ts'});return ui.Box({children:['one','two','held','denied','failed','rewrite','readonly','invalid-deny','deny-after-next'].map(key=>ui.Button({key,label:key,onPress:()=>{}}))})});
    on('ui.render',{component:'AbovePrompt'},($,e)=>$.ui.resolve(e).Input({key:'above',value:'',onInput:()=>{}}));
  }`)
  await runtime.reconcile([{ name: 'owner', storageId: 'owner@local', pluginRoot: root, entrypoints: [entry] }])
  runtime.registerHostCallback({ tier: 'prepend', registration: { id: 9, event: 'ui.focus', hasCatch: false } }, async (_$, e, next) => { events.push({ e: structuredClone(e), origin: next.origin }); return next(e) })
  const control = createModRemoteUIControl({ runtime: () => runtime, focus: message => messages.push(message), success: (message, value) => replies.set(message.request_id, value), error: (message, error) => replies.set(message.request_id, { error }) })
  let id = 0
  const start = (request: SDKControlRequest['request']) => { const request_id = String(++id); expect(control.handleRequest({ type: 'control_request', request_id, request })).toBe(true); return request_id }
  const send = async (request: SDKControlRequest['request']) => { const key = start(request); await control.settle(); return replies.get(key) }
  const focus = (changes: Record<string, unknown> = {}) => send({ subtype: 'ui_focus', component: 'Pane', instance_id: 'alpha', client_id: 'reader', is_held: true, element: { plugin: 'owner', key: 'one' }, ...changes } as any)
  const render = (changes: Record<string, unknown> = {}) => send({ subtype: 'ui_render', surface: 'desktop', component: 'Pane', instance_id: 'alpha', client_id: 'reader', props: {}, ...changes } as any)
  const author = async (input = { requestId: 'alpha', key: 'two' }) => (await runtime.dispatch('tool.call', { tool: 'owned', input }, async () => ({ result: null })) as any).result
  return { runtime, diagnostics, events, messages, replies, control, start, send, focus, render, author }
}
test('valid focus controls distinguish absent sites, undrawn elements, holding reports and keyboard release', async () => {
  const f = await fixture()
  expect(await f.focus()).toEqual({ moved: false, element: null, deny: 'no such site' })
  await f.send({ subtype: 'ui_attach', surface: 'desktop', client_id: 'reader' })
  expect(await f.focus()).toEqual({ moved: false, element: null, deny: 'no element of owner is drawn under that key' })
  await f.render()
  expect(await f.focus()).toEqual({ moved: true, element: { plugin: 'owner', key: 'one' } })
  expect(f.events.at(-1)).toEqual({ e: { component: 'Pane', requestId: 'alpha', plugin: 'owner', element: 'one', origin: { kind: 'person' } }, origin: { plugin: 'engine', tier: 'core' } })
  expect(await f.focus({ element: undefined })).toEqual({ moved: true, element: { plugin: 'owner', key: 'one' } })
  const count = f.events.length
  expect(await f.focus({ is_held: false })).toEqual({ moved: true, element: null })
  expect(f.events).toHaveLength(count)
  expect(await f.author()).toEqual({ deny: 'that site does not hold the keyboard' })
  await f.control.dispose()
})
test('focus middleware can deny or rewrite the key; invalid readonly rewrites fall back and retain real holder', async () => {
  const f = await fixture(); await f.render()
  expect(await f.focus({ element: { plugin: 'owner', key: 'denied' } })).toEqual({ moved: false, element: null, deny: 'keep it' })
  expect(await f.focus({ element: { plugin: 'owner', key: 'rewrite' } })).toEqual({ moved: true, element: { plugin: 'owner', key: 'one' } })
  expect(await f.focus({ element: { plugin: 'owner', key: 'readonly' } })).toEqual({ moved: true, element: { plugin: 'owner', key: 'readonly' } })
  expect(await f.focus({ element: { plugin: 'owner', key: 'failed' } })).toEqual({ moved: true, element: { plugin: 'owner', key: 'failed' } })
  expect(f.diagnostics).toHaveLength(2)
  expect(await f.focus({ element: null })).toEqual({ moved: true, element: null })
  await f.control.dispose()
})
test('author focus uses the drawn owner key and emits a typed SDK push to the latest renderer', async () => {
  const f = await fixture(); await f.render(); await f.focus()
  expect(await f.author()).toEqual({})
  expect(f.messages).toEqual([{ type: 'system', subtype: 'ui_focus', client_id: 'reader', component: 'Pane', instance_id: 'alpha', plugin: 'owner', key: 'two' }])
  expect(SDKMessageSchema().parse({ ...f.messages[0], uuid: 'owned', session_id: 'focus' })).toEqual({ ...f.messages[0], uuid: 'owned', session_id: 'focus' })
  await f.render({ client_id: 'other' }); expect(await f.author({ requestId: 'alpha', key: 'one' })).toEqual({})
  expect(f.messages.at(-1).client_id).toBe('other')
  expect(await f.author({ requestId: 'wrong', key: 'one' })).toEqual({ deny: "not this plugin's site" })
  expect(await f.author({ requestId: 'alpha', key: 'missing' })).toEqual({ deny: 'no element of its own is drawn under that key' })
  await f.control.dispose()
})
test('queued focus keeps a preceding explicit landing, replies to both pending reports and ignores SDK cancellation', async () => {
  const f = await fixture(); await f.render()
  const base = { subtype: 'ui_focus', component: 'Pane', instance_id: 'alpha', client_id: 'reader', is_held: true } as const
  const first = f.start({ ...base, element: { plugin: 'owner', key: 'held' } })
  while (!f.events.length) await Bun.sleep(1)
  const middle = f.start({ ...base, element: { plugin: 'owner', key: 'two' } }), last = f.start(base)
  f.control.cancel(first); await f.control.settle()
  expect(f.replies.get(first)).toEqual({ moved: true, element: { plugin: 'owner', key: 'held' } })
  expect(f.replies.get(middle)).toEqual({ moved: true, element: { plugin: 'owner', key: 'two' } })
  expect(f.replies.get(last)).toEqual(f.replies.get(middle)); expect(f.events.map(e => e.e.element)).toEqual(['held', 'two'])
  await f.control.dispose()
})
test('scroll reports and pane focus create shared sites; detach and close remove focus state', async () => {
  const f = await fixture(); await f.send({ subtype: 'ui_attach', surface: 'desktop', client_id: 'reader' })
  await f.send({ subtype: 'ui_scroll', component: 'Pane', instance_id: 'alpha', client_id: 'reader', offset: 0, by: 0, body_rows: 0, content_rows: 0 })
  expect(await f.focus({ client_id: 'stranger', element: undefined })).toEqual({ moved: true, element: null })
  await f.render(); await f.focus()
  await f.send({ subtype: 'ui_pane_focus', id: null, client_id: 'reader' })
  expect(await f.author()).toEqual({ deny: 'that site does not hold the keyboard' })
  await f.send({ subtype: 'ui_pane_focus', id: 'alpha', client_id: 'reader' })
  expect(await f.author()).toEqual({})
  await f.send({ subtype: 'ui_detach', client_id: 'reader' })
  expect(await f.focus()).toEqual({ moved: false, element: null, deny: 'no such site' })
  await f.send({ subtype: 'ui_close', id: 'alpha' })
  expect(await f.author()).toEqual({ deny: "not this plugin's site" }); await f.control.dispose()
})
test('automatic reports cannot steal another plugin holder; malformed controls return the official error', async () => {
  const f = await fixture(); await f.render(); await f.focus()
  expect(await f.focus({ by: 'auto', element: { plugin: 'foreign', key: 'foreign' } })).toEqual({ moved: false, element: { plugin: 'owner', key: 'one' }, deny: "another plugin's element holds the keyboard" })
  expect(f.messages).toEqual([])
  expect((await f.focus({ is_held: 'yes' })).error).toContain('is_held a boolean'); await f.control.dispose()
})

test('author focus waits for a pending remote drawing and removes its subscriptions when it lands', async () => {
  const f = await fixture()
  await f.send({ subtype: 'ui_attach', surface: 'desktop', client_id: 'reader', viewport: { columns: 80, rows: 24, isFullscreen: false } })
  await f.focus({ element: undefined })
  await f.send({ subtype: 'ui_pane_show', id: 'alpha', client_id: 'reader' })
  const begun = Date.now(), pending = f.author()
  await Bun.sleep(20); await f.render()
  expect(await pending).toEqual({}); expect(Date.now() - begun).toBeLessThan(1000)
  expect(f.messages.at(-1)).toMatchObject({ key: 'two' }); await f.control.dispose()
})

 test('render keyboard facts precede hooks and discarded focusable keys clear the actual holder', async () => {
  const f = await fixture()
  await f.render({props:{isFocused:true}})
  expect(await f.author()).toEqual({})
  await f.render({props:{isFocused:false}})
  expect(await f.author()).toEqual({deny:'that site does not hold the keyboard'})
  await f.focus()
  await f.render({props:{empty:true}})
  expect(await f.focus({element:undefined})).toEqual({moved:true,element:null})
  expect(await f.author()).toEqual({deny:'no element of its own is drawn under that key'})
  await f.control.dispose()
 })

test('browser Client roots never become keyboard focusable elements', async () => {
  const f = await fixture()
  const result = await f.render({props:{client:true,isFocused:true}})
  expect(result.tree.type).toBe('Client')
  expect(await f.focus({element:{plugin:'owner',key:'client'}})).toEqual({moved:false,element:null,deny:'no element of owner is drawn under that key'})
  await f.control.dispose()
})

test('focus results reject empty denial and cannot deny an already committed next result', async () => {
  const f = await fixture(); await f.render()
  expect(await f.focus({element:{plugin:'owner',key:'invalid-deny'}})).toEqual({moved:true,element:{plugin:'owner',key:'invalid-deny'}})
  expect(await f.focus({element:{plugin:'owner',key:'deny-after-next'}})).toEqual({moved:true,element:{plugin:'owner',key:'one'}})
  expect(f.diagnostics).toHaveLength(2)
  await f.control.dispose()
})
