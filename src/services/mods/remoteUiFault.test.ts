import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime } from './runtime.js'
import { createModRemoteRenderer } from './remoteUiRender.js'
import { createModRemoteUIControl } from './remoteUiControl.js'
import { normalizeModClientFaultReason } from './remoteUiClient.js'
import { SDKMessageSchema } from '../../entrypoints/sdk/coreSchemas.js'
import { SDKUISystemMessageSchema } from '../../entrypoints/sdk/modsControlSchemas.js'
import type {
  SDKControlUIClientFaultRequest,
  SDKControlUIRenderRequest,
} from '../../entrypoints/sdk/modsControlTypes.js'

let root: string
const envKeys = [
  'HOME',
  'USERPROFILE',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_PLUGIN_CACHE_DIR',
]
let saved: (string | undefined)[]
const cleanups: (() => Promise<unknown>)[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mods-remote-fault-'))
  saved = envKeys.map((key) => process.env[key])
  for (const key of envKeys) process.env[key] = join(root, 'config')
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  envKeys.forEach((key, index) => {
    if (saved[index] === undefined) delete process.env[key]
    else process.env[key] = saved[index]
  })
  await rm(root, { recursive: true, force: true })
})
const draw = (id = 'site', props = {}): SDKControlUIRenderRequest => ({
  subtype: 'ui_render',
  surface: 'desktop',
  component: 'Pane',
  instance_id: id,
  props,
})
async function fixture() {
  const logs: any[] = [],
    invalidations: unknown[] = []
  const runtime = createModsRuntime({
    services: { uiLog: (_plugin, text) => logs.push(JSON.parse(text)) },
  })
  cleanups.push(() => runtime.dispose())
  const declarations = []
  for (const name of ['owner', 'peer']) {
    const pluginRoot = join(root, name),
      entry = join(pluginRoot, 'hooks/register.ts')
    await mkdir(join(pluginRoot, 'hooks'), { recursive: true })
    await writeFile(
      entry,
      name === 'peer'
        ? `export function register(on) {
      on('ui.fault',($,e)=>{$.ui.log(JSON.stringify({phase:'peer',e}));return {}})
    }`
        : `export function register(on) {
      on('ui.render',{component:'Pane'},($,e)=>{
        $.ui.log(JSON.stringify({phase:'draw',id:e.requestId}));
        const ui=$.ui.resolve(e);
        return e.props.remove||e.surface!=='desktop'?ui.Text({children:'removed'}):ui.Client({key:'client',module:'./view.ts',props:e.props});
      });
      on('ui.fault',{phase:['load','render']},async($,e,next)=>{
        const failures=[];
        for(const key of ['surface','component','requestId','element','module','phase','reason']) {
          try {await next({...e,[key]:'forged'})}catch(error){failures.push(key)}
        }
        const empty=await next({});
        $.ui.log(JSON.stringify({phase:'fault',e,origin:next.origin,failures,empty}));
        if(e.reason==='hold')await $.clock.sleep(40);
        $.ui.log(JSON.stringify({phase:'exit',reason:e.reason}));
        // Runtime observes completion; the strict author result is still empty.
        return e.reason==='nonempty'?{ignored:true}:e.reason==='undefined'?undefined:next(e);
      });
    }`,
    )
    await writeFile(
      join(pluginRoot, 'hooks/view.ts'),
      "export default function View(){throw Error('CLIENT_MUST_RUN_ON_SURFACE')}",
    )
    declarations.push({
      name,
      storageId: name + '@fault',
      pluginRoot,
      entrypoints: [entry],
    })
  }
  await runtime.bind({
    cwd: root,
    surface: null,
    isInteractive: false,
    sessionId: 'owned-fault',
  })
  await runtime.reconcile(declarations)
  const renderer = createModRemoteRenderer(runtime, {
    invalidate: (instances) => invalidations.push(instances),
  })
  cleanups.push(() => renderer.dispose())
  const tree = (await renderer.render(draw())).tree
  if (tree.type !== 'Client') throw Error('expected external Client')
  const fault: SDKControlUIClientFaultRequest = {
    subtype: 'ui_client_fault',
    plugin: tree.client.plugin,
    component: 'Pane',
    instance_id: 'site',
    client: tree.props.key,
    module: tree.props.module,
    phase: 'render',
    reason: 'failure',
  }
  return { runtime, renderer, fault, logs, invalidations }
}

test('external faults pin the seven author fields, restore next({}), and isolate the owner', async () => {
  const { renderer, fault, logs, invalidations } = await fixture()
  for (const phase of ['load', 'render', 'run'] as const)
    expect(await renderer.clientFault({ ...fault, phase })).toEqual({
      handled: true,
    })
  const events = logs.filter((event) => event.phase === 'fault')
  expect(events).toHaveLength(2)
  expect(events[0]).toEqual({
    phase: 'fault',
    e: {
      surface: 'desktop',
      component: 'Pane',
      requestId: 'site',
      element: 'client',
      module: 'hooks/view.ts',
      phase: 'load',
      reason: 'failure',
    },
    origin: { plugin: 'engine', tier: 'core' },
    failures: [
      'surface',
      'component',
      'requestId',
      'element',
      'module',
      'phase',
      'reason',
    ],
    empty: {},
  })
  expect(logs.some((event) => event.phase === 'peer')).toBe(false)
  expect(logs.filter((event) => event.phase === 'draw')).toHaveLength(1)
  expect(invalidations).toEqual([
    [{ surface: 'desktop', component: 'Pane', instance_id: 'site' }],
  ])
  for (const reason of ['undefined', 'nonempty'])
    expect(await renderer.clientFault({ ...fault, reason })).toEqual({
      handled: true,
    })
})

test('fault recovery waits for ui_render and does not loop across repeated faults or prop changes', async () => {
  const { runtime, renderer, fault, logs, invalidations } = await fixture()
  await renderer.clientFault(fault)
  expect(logs.filter((event) => event.phase === 'draw')).toHaveLength(1)
  await renderer.render(draw())
  expect(logs.filter((event) => event.phase === 'draw')).toHaveLength(2)
  await renderer.clientFault(fault)
  await renderer.render(draw('site', { changed: true }))
  await renderer.clientFault(fault)
  expect(invalidations).toHaveLength(1)
  await renderer.render({ ...draw(), surface: 'mobile' })
  await runtime.ui.invalidateInstance({
    surface: 'mobile',
    component: 'Pane',
    requestId: 'site',
  })
  expect(invalidations).toHaveLength(2)
  await renderer.clientFault(fault)
  expect(invalidations).toHaveLength(2)
  await runtime.ui.invalidateInstance({
    surface: 'desktop',
    component: 'Pane',
    requestId: 'site',
  })
  expect(invalidations).toHaveLength(3)
  await renderer.clientFault(fault)
  expect(invalidations).toHaveLength(4)
  await renderer.clientFault(fault)
  expect(invalidations).toHaveLength(4)
})

test('stale addresses, unmatched owners, empty sites, and removed held clients do not request recovery', async () => {
  const { renderer, fault, logs, invalidations } = await fixture()
  for (const key of ['plugin', 'component', 'instance_id', 'client', 'module'])
    expect(
      await renderer.clientFault({
        ...fault,
        [key]: 'foreign',
      } as SDKControlUIClientFaultRequest),
    ).toEqual({ handled: false })
  expect(await renderer.clientFault({ ...fault, phase: 'run' })).toEqual({
    handled: true,
  })
  await renderer.render(draw(''))
  expect(await renderer.clientFault({ ...fault, instance_id: '' })).toEqual({
    handled: true,
  })
  expect(invalidations).toEqual([])
  const pending = renderer.clientFault({ ...fault, reason: 'hold' })
  for (
    let i = 0;
    !logs.some(
      (event) => event.phase === 'fault' && event.e.reason === 'hold',
    ) && i < 100;
    i++
  )
    await Bun.sleep(1)
  expect(
    logs.some((event) => event.phase === 'fault' && event.e.reason === 'hold'),
  ).toBe(true)
  await renderer.render(draw('site', { remove: true }))
  expect(await pending).toEqual({ handled: true })
  expect(invalidations).toEqual([])
  expect(await renderer.clientFault(fault)).toEqual({ handled: false })
})

test('faults serialize per owner and fault cancellation leaves the observation and reply intact', async () => {
  const { runtime, fault, logs } = await fixture()
  const replies: unknown[] = [],
    errors: unknown[] = [],
    notices: unknown[] = []
  const control = createModRemoteUIControl({
    runtime: () => runtime,
    success: (_message, response) => replies.push(response),
    error: (_message, reason) => errors.push(reason),
    invalidate: (message) => notices.push(message),
  })
  cleanups.push(() => control.dispose())
  control.handleRequest({
    type: 'control_request',
    request_id: 'draw',
    request: draw(),
  })
  await control.settle()
  replies.length = 0
  control.handleRequest({
    type: 'control_request',
    request_id: 'cancelled',
    request: { ...fault, reason: 'hold' },
  })
  control.cancel('cancelled')
  control.handleRequest({
    type: 'control_request',
    request_id: 'next',
    request: { ...fault, reason: 'second' },
  })
  await control.settle()
  expect(errors).toEqual([])
  expect(replies).toEqual([{ handled: true }, { handled: true }])
  expect(
    logs
      .filter((event) => ['fault', 'exit'].includes(event.phase))
      .map((event) => event.phase + ':' + (event.reason ?? event.e.reason)),
  ).toEqual(['fault:hold', 'exit:hold', 'fault:second', 'exit:second'])
  expect(notices).toEqual([
    {
      type: 'system',
      subtype: 'ui_invalidate',
      event: 'ui.render',
      instances: [
        { surface: 'desktop', component: 'Pane', instance_id: 'site' },
      ],
    },
  ])
})

test('fault reasons normalize controls, owner prefixes, blank failures and UTF-16 limits', () => {
  expect(
    normalizeModClientFaultReason(
      'owner',
      'hooks/view.ts',
      'owner: Client hooks/view.ts: first\nsecond\u2028third',
    ),
  ).toBe('first second third')
  expect(normalizeModClientFaultReason('owner', 'hooks/view.ts', '\n\t')).toBe(
    'the module failed without a message',
  )
  expect(
    normalizeModClientFaultReason(
      'owner',
      'hooks/view.ts',
      'a\ud800\u{10eeee}b😀',
    ),
  ).toBe('a  b😀')
  expect(
    normalizeModClientFaultReason(
      'owner',
      'hooks/view.ts',
      'x'.repeat(198) + '😀end',
    ),
  ).toBe('x'.repeat(198) + '…')
})

test('targeted and global ui_invalidate are finite SDK messages', () => {
  const message = {
    type: 'system',
    subtype: 'ui_invalidate',
    event: 'ui.render',
    uuid: 'owned',
    session_id: 'session',
    instances: [{ surface: 'desktop', component: 'Pane', instance_id: 'site' }],
  }
  expect(SDKMessageSchema().safeParse(message).success).toBe(true)
  expect(SDKUISystemMessageSchema().safeParse(message).success).toBe(true)
  const { instances, ...global } = message
  expect(SDKMessageSchema().safeParse(global).success).toBe(true)
  for (const invalid of [
    { ...message, event: 'ui.fault' },
    { ...message, instances: null },
    { ...message, instances: [{ ...instances[0], surface: 'terminal' }] },
    { ...message, instances: [{ ...instances[0], component: 'Other' }] },
    { ...message, instances: [{ surface: 'desktop', component: 'Pane' }] },
  ])
    expect(SDKMessageSchema().safeParse(invalid).success).toBe(false)
})
