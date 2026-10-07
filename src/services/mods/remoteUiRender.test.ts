import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime, type ModsRuntime } from './runtime.js'
import {
  createModRemoteRenderer,
  normalizeModRemoteRender,
} from './remoteUiRender.js'
import {
  createModRemoteUIControl,
  modUIRenderError,
} from './remoteUiControl.js'
import { SDKControlUIRenderResponseSchema } from '../../entrypoints/sdk/modsControlSchemas.js'
import type {
  SDKControlUIRenderRequest,
  SDKControlRequest,
} from '../../entrypoints/sdk/controlTypes.js'

let root: string
let saved: (string | undefined)[]
const envKeys = [
  'HOME',
  'USERPROFILE',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_PLUGIN_CACHE_DIR',
]
const cleanups: (() => Promise<unknown>)[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mods-remote-render-'))
  saved = envKeys.map((key) => process.env[key])
  for (const key of envKeys) process.env[key] = join(root, 'config')
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  envKeys.forEach((key, i) => {
    if (saved[i] === undefined) delete process.env[key]
    else process.env[key] = saved[i]
  })
  await rm(root, { recursive: true, force: true })
})
const request = (
  mode: string,
  overrides: Partial<SDKControlUIRenderRequest> = {},
): SDKControlUIRenderRequest => ({
  subtype: 'ui_render',
  surface: 'desktop',
  component: 'ToolUse',
  instance_id: mode,
  props: { mode },
  ...overrides,
})
async function fixture() {
  const logs: unknown[] = [],
    diagnostics: unknown[] = []
  const runtime = createModsRuntime({
    onDiagnostic: (event) => diagnostics.push(event),
    services: { uiLog: (_plugin, text) => logs.push(JSON.parse(text)) },
  })
  cleanups.push(() => runtime.dispose())
  const pluginRoot = join(root, 'plugin')
  await mkdir(join(pluginRoot, 'hooks'), { recursive: true })
  const entry = join(pluginRoot, 'hooks/register.ts')
  await writeFile(
    entry,
    `async function draw($,e,next) {
    const ui=$.ui.resolve(e),mode=e.props.mode;
    $.ui.log(JSON.stringify({phase:'render',props:e.props}));
    if(mode==='next')return next(e);
    if(mode==='rewrite')return next({...e,props:{...e.props,added:'owned'}});
    if(mode==='nested')return ui.Box({children:[await next(e),await next({...e,props:{...e.props,added:'second'}})]});
    if(mode==='throw')throw Error('owned render failure');
    if(mode==='bad')return {type:'UnknownOwned'};
    if(mode==='readonly')return next({...e,props:{...e.props,onScreen:{first:0,last:0,of:1}}});
    if(mode==='button')return ui.Button({key:'button',label:'Run',onPress:event=>$.ui.log(JSON.stringify({phase:'press',event}))});
    if(mode==='input')return ui.Input({key:'input',value:'',onInput:(value,event)=>$.ui.log(JSON.stringify({phase:'change',value,event})),onSubmit:(value,event)=>$.ui.log(JSON.stringify({phase:'submit',value,event}))});
    if(mode==='select')return ui.Select({key:'select',options:[{value:'a'}],onSelect:(value,event)=>$.ui.log(JSON.stringify({phase:'select',value,event}))});
    if(mode==='client')return ui.Client({key:'client',module:'./surface.ts',props:{label:'remote'}});
    if(mode==='wait'){await $.clock.sleep(40);$.ui.log(JSON.stringify({phase:'settled'}));}
    return ui.Text({children:'remote'});
  }
  export function register(on) {
    on('ui.render',{component:'ToolUse',surface:'desktop'},draw);
    on('ui.render',{component:'Pane',surface:'desktop'},draw);
  }`,
  )
  await writeFile(
    join(pluginRoot, 'hooks/surface.ts'),
    "export default function View(props,s){throw Error('OWNED_CLIENT_MUST_STAY_EXTERNAL')}",
  )
  await runtime.bind({
    cwd: root,
    surface: null,
    isInteractive: false,
    sessionId: 'remote-render',
  })
  await runtime.reconcile([
    {
      name: 'owned-duration-owner',
      storageId: 'remote@test',
      pluginRoot,
      entrypoints: [entry],
    },
  ])
  expect(diagnostics).toEqual([])
  const renderer = createModRemoteRenderer(runtime)
  cleanups.push(() => renderer.dispose())
  return { runtime, renderer, logs, diagnostics }
}

test('normalizes transcript ownership and truncates UTF-16 output without splitting a surrogate', () => {
  const original = request('next', {
    props: {
      tool_use_id: 42,
      onScreen: 'spoof',
      output: 'a'.repeat(65535) + '😀tail',
    },
    on_screen: null,
  })
  const input = normalizeModRemoteRender(original)
  expect(input.props.tool_use_id).toBe('next')
  expect(input.props.onScreen).toBeNull()
  expect(input.props.output).toBe('a'.repeat(65535))
  expect(original.props.onScreen).toBe('spoof')
  expect(
    normalizeModRemoteRender(
      request('next', { props: { tool_use_id: '', onScreen: null } }),
    ).props,
  ).toEqual({ tool_use_id: '' })
  expect(
    normalizeModRemoteRender(
      request('text', {
        component: 'PromptHint',
        props: { onScreen: 'kept' },
        on_screen: null,
      }),
    ).props,
  ).toEqual({ onScreen: 'kept' })
})

test('matches official next(), selected engine ref, fallback and component-only hooked receipts', async () => {
  const { renderer, diagnostics } = await fixture()
  const first = await renderer.render(request('text'))
  expect(diagnostics).toEqual([])
  expect(first).toEqual({
    tree: { type: 'Text', children: ['remote'] },
    props: { mode: 'text', tool_use_id: 'text' },
    rewritten: false,
    hooked: true,
  })
  for (const mode of ['next', 'throw'])
    expect(await renderer.render(request(mode))).toEqual({
      tree: { type: 'engine', ref: 1 },
      props: { mode, tool_use_id: mode },
      rewritten: true,
      hooked: true,
    })
  expect(await renderer.render(request('bad'))).toEqual({
    tree: { type: 'engine', ref: 0 },
    props: { mode: 'bad', tool_use_id: 'bad' },
    rewritten: false,
    hooked: true,
  })
  expect(await renderer.render(request('rewrite'))).toMatchObject({
    props: { added: 'owned' },
    rewritten: true,
  })
  expect(await renderer.render(request('nested'))).toEqual({
    tree: {
      type: 'Box',
      children: [
        { type: 'engine', ref: 1 },
        { type: 'engine', ref: 2 },
      ],
    },
    props: { mode: 'nested', tool_use_id: 'nested' },
    rewritten: true,
    hooked: true,
  })
  expect(
    await renderer.render(request('next', { surface: 'vscode' })),
  ).toMatchObject({
    tree: { type: 'engine', ref: 0 },
    rewritten: false,
    hooked: true,
  })
  expect(
    await renderer.render(request('next', { component: 'Spinner' })),
  ).toMatchObject({
    tree: { type: 'engine', ref: 0 },
    rewritten: false,
    hooked: false,
  })
  expect(
    await renderer.render(
      request('readonly', { on_screen: { first: 1, last: 1, of: 2 } }),
    ),
  ).toMatchObject({
    tree: { type: 'engine', ref: 1 },
    props: { onScreen: { first: 1, last: 1, of: 2 } },
    rewritten: true,
  })
  expect(
    await renderer.render(request('next', { instance_id: '' })),
  ).toMatchObject({
    tree: { type: 'engine', ref: 1 },
    props: { tool_use_id: '' },
    rewritten: true,
  })
})

test('owns callback handles, routes canonical events and retires replaced drawings', async () => {
  const { renderer, logs } = await fixture()
  const button = await renderer.render(request('button'))
  expect(SDKControlUIRenderResponseSchema().safeParse(button).success).toBe(
    true,
  )
  expect(button.tree).not.toHaveProperty('group')
  if (button.tree.type !== 'Button') throw new Error('expected Button')
  const press = { subtype: 'ui_press' as const, ...button.tree.press }
  expect(await renderer.interact({ ...press, key: 'foreign' })).toEqual({
    handled: false,
  })
  expect(await renderer.interact(press)).toEqual({
    handled: true,
    element: 'button',
  })
  expect(logs).toContainEqual({
    phase: 'press',
    event: {
      surface: 'desktop',
      component: 'ToolUse',
      requestId: 'button',
      plugin: 'owned-duration-owner',
      element: 'button',
    },
  })
  await renderer.render(request('text', { instance_id: 'button' }))
  expect(await renderer.interact(press)).toEqual({ handled: false })
  const input = await renderer.render(request('input'))
  if (input.tree.type !== 'Input') throw new Error('expected Input')
  for (const kind of ['change', 'submit'] as const)
    expect(
      await renderer.interact({
        subtype: 'ui_input',
        ...input.tree.press,
        kind,
        value: 'draft',
      }),
    ).toEqual({ handled: true, element: 'input', value: 'draft' })
  const select = await renderer.render(request('select'))
  if (select.tree.type !== 'Select') throw new Error('expected Select')
  expect(
    await renderer.interact({
      subtype: 'ui_select',
      ...select.tree.press,
      value: 'a',
    }),
  ).toEqual({ handled: true, element: 'select', value: 'a' })
  await renderer.dispose()
  expect(await renderer.interact(press)).toEqual({ handled: false })
})

test('serves exactly the observed Client bundle hash without mounting the client on the server', async () => {
  const { runtime, renderer, diagnostics } = await fixture()
  const result = await renderer.render(request('client', { component: 'Pane' }))
  expect(diagnostics).toEqual([])
  expect(result.tree).toEqual({
    type: 'Client',
    props: {
      key: 'client',
      module: 'hooks/surface.ts',
      props: { label: 'remote' },
    },
    client: { plugin: 'owned-duration-owner' },
  })
  expect(result.client_modules).toEqual({
    'owned-duration-owner':
      '9ad0ce36658d0192ea713ec6529d6c36e716993b8a4b13579c9cf80b0343b320',
  })
  expect(runtime.clientModule('missing')).toBeUndefined()
  expect(runtime.clientModule('owned-duration-owner')?.modules).toEqual([
    {
      module: 'hooks/surface.ts',
      entry: 'surface:///hooks/surface.ts',
      component: 'default',
    },
  ])
  expect(diagnostics).toEqual([])
})

test('empty IDs bypass the draw cache, settled identical requests reuse it, viewport rows do not invalidate it', async () => {
  const { renderer, logs } = await fixture()
  const input = request('text', { viewport: { columns: 80, rows: 20 } })
  await renderer.render(input)
  await renderer.render({ ...input, viewport: { columns: 80, rows: 40 } })
  expect(logs).toHaveLength(1)
  await renderer.render({ ...input, viewport: { columns: 81, rows: 40 } })
  expect(logs).toHaveLength(2)
  await renderer.render({ ...input, instance_id: '' })
  await renderer.render({ ...input, instance_id: '' })
  expect(logs).toHaveLength(4)
})

test('concurrent replacement draws keep their own replies without cancelling an older hook', async () => {
  const { renderer, logs } = await fixture()
  const first = renderer.render(request('wait', { instance_id: 'overlap' }))
  for (let i = 0; i < 100 && !logs.length; i++) await Bun.sleep(1)
  expect(logs.length).toBeGreaterThan(0)
  const second = renderer.render(request('rewrite', { instance_id: 'overlap' }))
  const third = renderer.render(request('text', { instance_id: 'overlap' }))
  const results = await Promise.all([first, second, third])
  expect(results[0]).toMatchObject({
    tree: { type: 'Text', children: ['remote'] },
    props: { mode: 'wait' },
  })
  expect(results[1]).toMatchObject({
    tree: { type: 'engine', ref: 1 },
    props: { mode: 'rewrite', added: 'owned' },
  })
  expect(results[2]).toMatchObject({
    tree: { type: 'Text', children: ['remote'] },
    props: { mode: 'text' },
  })
  expect(logs).toContainEqual({ phase: 'settled' })
})

function controller(runtime: ModsRuntime) {
  const replies: {
    id: string
    value?: Record<string, unknown>
    error?: string
  }[] = []
  const control = createModRemoteUIControl({
    runtime: () => runtime,
    success: (message, value) =>
      replies.push({ id: message.request_id, value }),
    error: (message, error) => replies.push({ id: message.request_id, error }),
  })
  cleanups.push(() => control.dispose())
  const send = (id: string, request: SDKControlRequest['request']) =>
    control.handleRequest({ type: 'control_request', request_id: id, request })
  return { replies, control, send }
}

test('control cancellation suppresses replies while the actual Worker draw settles and adjacent requests run', async () => {
  const { runtime, logs } = await fixture()
  const { send, control, replies } = controller(runtime)
  expect(send('cancelled', request('wait'))).toBe(true)
  for (let i = 0; i < 100 && !logs.length; i++) await Bun.sleep(1)
  expect(logs.length).toBeGreaterThan(0)
  control.cancel('cancelled')
  send('adjacent', request('text'))
  await control.settle()
  expect(logs).toContainEqual({ phase: 'settled' })
  expect(replies.map((reply) => reply.id)).toEqual(['adjacent'])
})

test('SDK render validation and client module errors match the official control boundary', async () => {
  const { runtime } = await fixture()
  const { send, control, replies } = controller(runtime)
  send('invalid', { ...request('next'), surface: 'terminal' })
  expect(replies).toEqual([{ id: 'invalid', error: modUIRenderError }])
  send('missing', { subtype: 'ui_client_module', plugin: 'missing' })
  await control.settle()
  expect(replies[1]).toEqual({
    id: 'missing',
    error:
      'ui_client_module: plugin missing is not loaded or its hooks module names no surface module',
  })
})
