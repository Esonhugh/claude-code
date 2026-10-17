import {afterEach, beforeEach, expect, test} from 'bun:test'
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createModsRuntime, type ModHostServices, type ModDiagnostic} from './runtime.js'

let root: string
const runtimes: ReturnType<typeof createModsRuntime>[] = []
const keys = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_CACHE_DIR'] as const
const prior = new Map<string, string | undefined>()
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'owned-ui-copy-')))
  for (const key of keys) prior.set(key, process.env[key])
  process.env.HOME = root
  process.env.USERPROFILE = root
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = join(root, 'cache')
})
afterEach(async () => {
  try { await Promise.all(runtimes.splice(0).map(value => value.dispose())) }
  finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    prior.clear()
    await rm(root, {recursive: true, force: true})
  }
})
async function fixture(body: string, services: ModHostServices = {}, surface: 'terminal' | null = 'terminal', policy?: string) {
  const pluginRoot = join(root, 'caller');await mkdir(pluginRoot)
  const entry = join(pluginRoot, 'register.ts')
  await writeFile(entry, `export function register(on){on('command.run',async($,e)=>{${body}})}`)
  const diagnostics: ModDiagnostic[] = []
  const value = createModsRuntime({services, onDiagnostic: event => diagnostics.push(event)})
  runtimes.push(value)
  await value.bind({cwd: root, surface, isInteractive: surface !== null, sessionId: 'copy-owned'})
  const policyRoot = join(root, 'policy'), policyEntry = join(policyRoot, 'register.ts')
  if (policy) {await mkdir(policyRoot);await writeFile(policyEntry, policy)}
  await value.reconcile([
    ...(policy ? [{name: 'copy-policy', storageId: 'copy-policy@owned', pluginRoot: policyRoot, entrypoints: [policyEntry], tier: 'prepend' as const}] : []),
    {name: 'copy-caller', storageId: 'copy-caller@owned', pluginRoot, entrypoints: [entry]},
  ])
  expect(diagnostics).toEqual([])
  const call = (signal?: AbortSignal) => value.dispatch('command.run', {}, async () => ({text: 'unhandled'}), {signal})
  return {value, diagnostics, call}
}

async function attach(value: ReturnType<typeof createModsRuntime>, clientId: string) {
  return value.ui.mount({surface: 'desktop', component: 'AbovePrompt', requestId: clientId, props: {}}, {
    surface: 'desktop', clientId, render() {}, unmount() {},
  })
}

test('real Worker copy preserves text verbatim and only reads official public argument fields', async () => {
  const received: unknown[] = []
  const {call, diagnostics} = await fixture(`const order=[];
    const result=await $.ui.copy({get text(){order.push('text');return 'a\\n你好'},get surface(){order.push('surface');return 'terminal'},get ignored(){throw Error('unused')}});
    return {text:JSON.stringify({result,order})}`, {uiCopy: async (input, plugin) => {received.push({input, plugin});return {isCopied: true}}})
  expect(await call()).toEqual({text: JSON.stringify({result: {isCopied: true}, order: ['text', 'surface', 'surface']})})
  expect(received).toEqual([{input: {text: 'a\n你好', surface: 'terminal'}, plugin: 'copy-caller'}])
  expect(diagnostics).toEqual([])
})

test('copy stamps the first attached surface before middleware and permits text and target rewrites', async () => {
  const received: unknown[] = []
  const {value, call, diagnostics} = await fixture(`return {text:JSON.stringify(await $.ui.copy({text:'original'}))}`, {
    uiCopy: async (input, plugin) => {received.push({input, plugin});return {isCopied: true}},
  }, 'terminal', `export function register(on){on('ui.copy',async($,e,next)=>{
    if(JSON.stringify(e)!==JSON.stringify({text:'original',surface:'terminal'}))throw Error('copy input was not stamped');
    if(!Object.isFrozen(e))throw Error('author copy input was not frozen');
    if(next.origin.plugin!=='copy-caller'||next.origin.tier!=='user')throw Error('wrong copy caller');
    return next({...e,text:'rewritten',surface:'desktop'});
  })}`)
  await attach(value, 'owned-desktop')
  expect(await call()).toEqual({text: '{"isCopied":true}'})
  expect(received).toEqual([{input: {text: 'rewritten', surface: 'desktop'}, plugin: 'copy-caller'}])
  expect(diagnostics).toEqual([])
})

test('copy without a drawing surface or with an unattached target returns no-surface', async () => {
  let copies = 0
  const {call, diagnostics} = await fixture(`return {text:JSON.stringify([await $.ui.copy({text:'none'}),await $.ui.copy({text:'named',surface:'desktop'})])}`, {uiCopy: async () => {copies++;return {isCopied: true}}}, null)
  expect(await call()).toEqual({text: JSON.stringify([{isCopied: false, reason: 'no-surface'}, {isCopied: false, reason: 'no-surface'}])})
  expect(copies).toBe(0)
  expect(diagnostics).toEqual([])
})

test('an attached remote surface with no clipboard responder returns no-clipboard', async () => {
  const {value, call, diagnostics} = await fixture(`return {text:JSON.stringify(await $.ui.copy({text:'remote',surface:'desktop'}))}`, {}, null)
  await attach(value, 'owned-remote')
  expect(await call()).toEqual({text: '{"isCopied":false,"reason":"no-clipboard"}'})
  expect(diagnostics).toEqual([])
})

test('copy middleware may answer a refusal itself or deny without retiring the author', async () => {
  let copies = 0
  const {value, call, diagnostics} = await fixture(`let reason;try{return {text:JSON.stringify(await $.ui.copy({text:'held'}))}}catch(error){reason=error.message}return {text:reason}`, {uiCopy: async () => {copies++;return {isCopied: true}}})
  let denied = false
  const remove = value.registerHostHook({plugin: 'policy', tier: 'prepend', registration: {id: 1, event: 'ui.copy', hasCatch: false}, invoke: async () => denied ? {deny: 'copy held'} : {value: {isCopied: false, reason: 'refused'}}})
  expect(await call()).toEqual({text: '{"isCopied":false,"reason":"refused"}'})
  denied = true
  expect(await call()).toEqual({text: 'copy held'})
  expect(copies).toBe(0)
  remove()
  expect(await call()).toEqual({text: '{"isCopied":true}'})
  expect(copies).toBe(1)
  expect(diagnostics).toEqual([])
})

test('invalid public copy arguments are rejected before middleware without coercing text', async () => {
  let entries = 0
  const {value, call, diagnostics} = await fixture(`const caught=[];for(const input of [undefined,null,{text:9},{text:{toString(){throw Error('must not coerce')}}},{text:'x',surface:'other'}]){try{await $.ui.copy(input);caught.push(false)}catch{caught.push(true)}}return {text:JSON.stringify(caught)}`)
  value.registerHostHook({plugin: 'observer', tier: 'prepend', registration: {id: 1, event: 'ui.copy', hasCatch: false}, invoke: async () => {entries++;return {value: {isCopied: true}}}})
  expect(await call()).toEqual({text: '[true,true,true,true,true]'})
  expect(entries).toBe(0)
  expect(diagnostics).toEqual([])
})

test('copy public getters fail synchronously and never reach the host', async () => {
  let copies = 0
  const {call, diagnostics} = await fixture(`const messages=[];for(const input of [{get text(){throw Error('text getter')}},{text:'x',get surface(){throw Error('surface getter')}}]){try{$.ui.copy(input);messages.push('not thrown')}catch(error){messages.push(error.message)}}return {text:JSON.stringify(messages)}`, {uiCopy: async () => {copies++;return {isCopied: true}}})
  expect(await call()).toEqual({text: '["text getter","surface getter"]'})
  expect(copies).toBe(0)
  expect(diagnostics).toEqual([])
})

test('copy middleware keeps the generic value envelope for an untyped JavaScript author', async () => {
  const {call, diagnostics} = await fixture(`return {text:JSON.stringify(await $.ui.copy({text:'custom'}))}`, {}, 'terminal',
    `export function register(on){on('ui.copy',()=>({value:{isCopied:'probe',note:'opaque'}}))}`)
  expect(await call()).toEqual({text: '{"isCopied":"probe","note":"opaque"}'})
  expect(diagnostics).toEqual([])
})

test('a remote copy over the official character bound is not sent to its responder', async () => {
  let copies = 0
  const {value, call, diagnostics} = await fixture(`return {text:JSON.stringify(await $.ui.copy({text:'x'.repeat(1000001),surface:'desktop'}))}`, {uiCopy: async () => {copies++;return {isCopied: true}}}, null)
  await attach(value, 'owned-remote')
  expect(await call()).toEqual({text: '{"isCopied":false,"reason":"no-clipboard"}'})
  expect(copies).toBe(0)
  expect(diagnostics).toEqual([])
})
