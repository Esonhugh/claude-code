import { expect, test } from 'bun:test'
import { createModsRuntime, type ModSnapshot } from './runtime.js'
import { seatNativeModPlugins } from './native.js'
import { validateModRegistrations } from './loader.js'
import type { ModDeclaration, PromptComposeResult } from './types.js'

const facts = { model: 'test-model', promptModel: 'test-model', surfaces: [], tools: [], outputStyle: null, traits: [] }
const body: PromptComposeResult = { sections: [{ id: 'body', text: 'the body', scope: 'shared' }] }
const settings = { userSettings: null, flagSettings: null, policySettings: null, hookPolicy: { managedOnly: false, allDisabled: false }, subscriptionType: 'team' as const }
function plugin(source: string) {
  const entry = 'builtin:compose-test/register.js'
  const declaration: ModDeclaration = {
    name: 'sec-default', storageId: 'sec-default@builtin', isNative: true,
    pluginRoot: 'builtin:compose-test', entrypoints: [entry], modules: [{ path: entry, source }],
    links: [], events: ['probe.call', 'prompt.compose'], calls: ['prompt.compose'],
    nextTiers: [], options: {}, tier: 'prepend', fingerprint: source,
  }
  return seatNativeModPlugins([], settings, declaration)
}

test('compose registration is accepted by the loader validator', () => {
  expect(() => validateModRegistrations({ events: ['prompt.compose'] } as ModDeclaration,
    [{ id: 1, event: 'prompt.compose', hasCatch: false }])).not.toThrow()
})

test('active compose delegates partial facts to capture binding and skips only calling frame', async () => {
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({ onDiagnostic: d => diagnostics.push(d) })
  let escaped: ModSnapshot | undefined
  const seen: unknown[] = []
  await runtime.reconcile(plugin(`export function register(on) {
    on('probe.call', async ($, e) => ({ value: await $.prompt.compose(e) }));
    on('prompt.compose', async ($, e, next) => {
      if (e.tools.includes('nested')) return next(e);
      return $.prompt.compose({ ...e, tools: ['nested'] });
    });
    on('prompt.compose', async ($, e, next) => {
      const result = await next(e);
      return { sections: [...result.sections, {id:'sec-default:tail',text:'tail',scope:'session'}] };
    });
  }`))
  const snapshot = runtime.capture({
    composePrompt: async (input, invocation, signal) => {
      seen.push(input)
      escaped = invocation
      expect(signal.aborted).toBe(false)
      return await invocation.dispatch('prompt.compose', { ...facts, ...input }, async () => body) as typeof body
    },
  })
  try {
    expect(await snapshot.dispatch('probe.call', { model: 'other' }, async () => ({ value: 'missing' }))).toEqual({ value: {
      sections: [...body.sections, { id: 'sec-default:tail', text: 'tail', scope: 'session' }],
    } })
    expect(seen).toEqual([{model:'other'}, {...facts, model:'other', tools:['nested']}])
    expect(diagnostics).toEqual([])
    expect(() => escaped!.dispatch('prompt.compose', facts, async () => body)).toThrow('settled')
  } finally { snapshot.release(); await runtime.dispose() }
})

test('compose defaults to omitted facts, rejects invalid args, and reports missing host', async () => {
  const runtime = createModsRuntime()
  await runtime.reconcile(plugin(`export function register(on) {
    on('probe.call', async ($, e) => {
      try { return { value: e.invalid ? await $.prompt.compose({traits:['invented']}) : await $.prompt.compose() }; }
      catch (error) { return { value: error.message }; }
    });
  }`))
  const snapshot = runtime.capture({ composePrompt: async input => {
    expect(input).toEqual({})
    return body
  } })
  try {
    expect(await snapshot.dispatch('probe.call', {}, async () => ({value:'missing'}))).toEqual({value:body})
    expect(await snapshot.dispatch('probe.call', {invalid:true}, async () => ({value:'missing'}))).toEqual({value:'Invalid prompt.compose traits'})
    expect(await runtime.dispatch('probe.call', {}, async () => ({value:'missing'}))).toEqual({value:'Prompt composition host is unavailable on this host'})
  } finally { snapshot.release(); await runtime.dispose() }
})

test('compose rejects malformed sections and pinned model rewrites through normal hook recovery', async () => {
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({ onDiagnostic: d => diagnostics.push(d) })
  runtime.registerHostHook({plugin:'bad',tier:'user',registration:{id:1,event:'prompt.compose',hasCatch:false},
    invoke: async () => ({sections:[...body.sections,...body.sections]})})
  runtime.registerHostHook({plugin:'rewrite',tier:'append',registration:{id:2,event:'prompt.compose',hasCatch:false},
    invoke: async (input,next) => next({...input,model:'rewritten'})})
  try {
    expect(await runtime.dispatch('prompt.compose', facts, async () => body)).toEqual(body)
    expect(diagnostics).toHaveLength(2)
  } finally { await runtime.dispose() }
})

test('native sec-default skips user composition hooks and retains append hooks', async () => {
  const runtime = createModsRuntime()
  const seen: string[] = []
  runtime.registerHostHook({ plugin:'person', tier:'user', registration:{id:1,event:'prompt.compose',hasCatch:false},
    invoke: async () => { seen.push('user'); return { sections: [] } } })
  runtime.registerHostHook({ plugin:'org', tier:'append', registration:{id:2,event:'prompt.compose',hasCatch:false},
    invoke: async (input, next) => { seen.push('append'); return next(input) } })
  try {
    await runtime.reconcile(seatNativeModPlugins([], settings))
    expect(await runtime.dispatch('prompt.compose', facts, async () => body)).toEqual(body)
    expect(seen).toEqual(['append'])
  } finally { await runtime.dispose() }
})
