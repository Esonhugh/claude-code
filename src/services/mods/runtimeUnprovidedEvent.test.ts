import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { beforeEach, afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createModsRuntime } from './runtime.js'

const evidenceRoot = tmpdir()

// Official 2.1.289 permits one unmatched plus exact-event matcher registrations.
// Empty sibling matchers preserve these always-matching hooks; see registrationMultiplicity289.test.ts.
const testEnvKeys = [
  'HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
]
let testConfigRoot: string | undefined
let savedTestEnvironment: (string | undefined)[] = []
beforeEach(async () => {
  savedTestEnvironment = testEnvKeys.map(key => process.env[key])
  testConfigRoot = await realpath(await mkdtemp(join(tmpdir(), 'mods-test-config-')))
  process.env.HOME = testConfigRoot
  process.env.CLAUDE_CONFIG_DIR = join(testConfigRoot, 'config')
  process.env.XDG_CONFIG_HOME = join(testConfigRoot, 'xdg-config')
  process.env.XDG_CACHE_HOME = join(testConfigRoot, 'xdg-cache')
  process.env.XDG_STATE_HOME = join(testConfigRoot, 'xdg-state')
  process.env.ANTHROPIC_API_KEY = 'sk-test-placeholder'
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  delete process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  resetSettingsCache()
})

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  } finally {
    resetSettingsCache()
    testEnvKeys.forEach((key, i) => {
      if (savedTestEnvironment[i] === undefined) delete process.env[key]
      else process.env[key] = savedTestEnvironment[i]
    })
    if (testConfigRoot !== undefined) {
      await rm(testConfigRoot, { recursive: true, force: true })
      testConfigRoot = undefined
    }
  }
})

async function fixture(source: string, name = 'fixture') {
  await mkdir(evidenceRoot, { recursive: true })
  const root = await realpath(await mkdtemp(join(evidenceRoot, 'mods-runtime-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const entry = join(root, 'register.ts')
  await writeFile(entry, source)
  return { name, storageId: name + '@inline', pluginRoot: root, entrypoints: [entry] }
}
function runtime() {
  const events: { plugin: string; stage: string; message: string; storageId?: string }[] = []
  const value = createModsRuntime({ onDiagnostic: event => events.push(event) })
  cleanups.push(() => value.dispose())
  return { value, events }
}
const input = { tool: 'Read', tool_use_id: 'test-call', file_path: '/tmp/.env' }
const deny = `on('tool.call', {tool:'Read'}, async ($, e, next) => ({deny:'ue: denied'}));`

describe('events no loaded plugin provides (official 2.1.329)', () => {
  test.each([
    [`on('nope.event', async ($, e, next) => next(e));`, 'registered nope.event, but no loaded plugin provides $.nope'],
    [`on('nope.*', async ($, e, next) => next(e));`, 'registered on("nope.*"), which selects no event'],
    [`on('!nope.*', async ($, e, next) => next(e));`, 'registered on("!nope.*"), whose negated pattern selects no event'],
    [`on('!nope.event', async ($, e, next) => next(e));`, 'registered on("!nope.event"), whose negated pattern selects no event'],
    [`on('engine.create', async ($, e, next) => { const built = await next(e); return {...built, nope: {hello: async () => 1}}; });
      on('nope.bye', async ($, e, next) => next(e));`, 'registered nope.bye, but $.nope (ue) has no method bye'],
  ])('%s unloads the whole module with a diagnostic', async (registration, reason) => {
    const plugin = await fixture(`export function register(on) { ${registration} ${deny} }`, 'ue')
    const { value, events } = runtime()
    await value.reconcile([plugin])
    expect(events).toEqual([{ plugin: 'ue', stage: 'load', message: `hooks module did not load: the $ build failed (${reason})`, storageId: 'ue@inline' }])
    expect(await value.dispatch('tool.call', input, async () => ({result:'core'}))).toEqual({result:'core'})
  })

  test('provided methods, their patterns and engine events stay registrable', async () => {
    const plugin = await fixture(`export function register(on) {
      on('engine.create', async ($, e, next) => { const built = await next(e); return {...built, nope: {hello: async () => 1}}; });
      on('nope.hello', async ($, e, next) => next(e));
      on('nope.*', {}, async ($, e, next) => next(e));
      on('!nope.*', {}, async ($, e, next) => next(e));
      on('classic.PreToolUse', async ($, e, next) => next(e));
      on('skill.prompt', async ($, e, next) => next(e));
      on('!ui.*', {}, async ($, e, next) => next(e));
      ${deny}
    }`, 'ue')
    const { value, events } = runtime()
    await value.reconcile([plugin])
    expect(events).toEqual([])
    expect(await value.dispatch('tool.call', input, async () => ({result:'core'}))).toEqual({deny:'ue: denied'})
  })

  // A module that judges plugin.register makes a cold start build $ before the later plugins are loaded.
  test.each([[['ue', 'provider']], [['provider', 'ue']]] as const)('a consumer that judges plugin.register keeps the events of a provider loaded after it (%p)', async order => {
    const sources = {
      provider: `export function register(on) {
        on('engine.create', async ($, e, next) => { const built = await next(e); return {...built, nope: {hello: async () => 1}}; });
      }`,
      ue: `export function register(on) {
        on('plugin.register', async ($, e, next) => next(e));
        on('nope.hello', async ($, e, next) => next(e));
        ${deny}
      }`,
    }
    const plugins = []
    for (const name of order) plugins.push(await fixture(sources[name], name))
    const { value, events } = runtime()
    await value.reconcile(plugins)
    expect(events).toEqual([])
    expect(await value.dispatch('tool.call', input, async () => ({result:'core'}))).toEqual({deny:'ue: denied'})
  })

  test.each([[['judge', 'x']], [['x', 'judge']]] as const)('a module that does not load for an unprovided event refuses no plugin (%p)', async order => {
    const sources = {
      judge: `export function register(on) {
        on('plugin.register', ($, e, next) => e.name === 'x' ? {refuse:'judge says no'} : next(e));
        on('nope.event', async ($, e, next) => next(e));
      }`,
      x: `export function register(on) { on('tool.call', {tool:'Read'}, async ($, e, next) => ({deny:'x: denied'})); }`,
    }
    const plugins = []
    for (const name of order) plugins.push(await fixture(sources[name], name))
    const { value, events } = runtime()
    await value.reconcile(plugins)
    expect(events).toEqual([{ plugin: 'judge', stage: 'load', message: 'hooks module did not load: the $ build failed (registered nope.event, but no loaded plugin provides $.nope)', storageId: 'judge@inline' }])
    expect(await value.dispatch('tool.call', input, async () => ({result:'core'}))).toEqual({deny:'x: denied'})
  })

  test('a judge whose event comes from a plugin loaded later still refuses the plugins between them', async () => {
    const plugins = [
      await fixture(`export function register(on) {
        on('plugin.register', ($, e, next) => e.name === 'x' ? {refuse:'judge says no'} : next(e));
        on('nope.hello', async ($, e, next) => next(e));
      }`, 'judge'),
      await fixture(`export function register(on) { on('tool.call', {tool:'Read'}, async ($, e, next) => ({deny:'x: denied'})); }`, 'x'),
      await fixture(`export function register(on) { on('engine.create', async ($, e, next) => { const built = await next(e); return {...built, nope: {hello: async () => 1}}; }); }`, 'provider'),
    ]
    const { value, events } = runtime()
    await value.reconcile(plugins)
    expect(events).toEqual([{ plugin: 'x', stage: 'admission', message: 'judge says no' }])
    expect(await value.dispatch('tool.call', input, async () => ({result:'core'}))).toEqual({result:'core'})
  })

  test('a judge that refuses the provider of its own event keeps it out and does not load', async () => {
    const plugins = [
      await fixture(`export function register(on) {
        on('plugin.register', ($, e, next) => e.name === 'provider' ? {refuse:'judge says no'} : next(e));
        on('nope.hello', async ($, e, next) => next(e));
      }`, 'judge'),
      await fixture(`export function register(on) {
        on('engine.create', async ($, e, next) => { const built = await next(e); return {...built, nope: {hello: async () => 1}}; });
        on('tool.call', {tool:'Read'}, async ($, e, next) => ({deny:'provider: denied'}));
      }`, 'provider'),
    ]
    const { value, events } = runtime()
    await value.reconcile(plugins)
    expect(events).toEqual([
      { plugin: 'provider', stage: 'admission', message: 'judge says no' },
      { plugin: 'judge', stage: 'load', message: 'hooks module did not load: the $ build failed (registered nope.hello, but no loaded plugin provides $.nope)', storageId: 'judge@inline' },
    ])
    expect(await value.dispatch('tool.call', input, async () => ({result:'core'}))).toEqual({result:'core'})
  })

  const unloadedJudge = (refused: string) => `export function register(on) {
    on('plugin.register', ($, e, next) => e.name === '${refused}' ? {refuse:'jbad says no'} : next(e));
    on('nope.event', async ($, e, next) => next(e));
  }`
  const jbadDidNotLoad = { plugin: 'jbad', stage: 'load', message: 'hooks module did not load: the $ build failed (registered nope.event, but no loaded plugin provides $.nope)', storageId: 'jbad@inline' }

  test('a judge that a module that does not load would have refused still judges the plugins after it', async () => {
    const plugins = [
      await fixture(unloadedJudge('policy'), 'jbad'),
      await fixture(`export function register(on) { on('plugin.register', ($, e, next) => e.name === 'y' ? {refuse:'policy says no'} : next(e)); }`, 'policy'),
      await fixture(`export function register(on) { on('tool.call', {tool:'Read'}, async ($, e, next) => ({deny:'y: denied'})); }`, 'y'),
    ]
    const { value, events } = runtime()
    await value.reconcile(plugins)
    expect(events).toEqual([jbadDidNotLoad, { plugin: 'y', stage: 'admission', message: 'policy says no' }])
    expect(await value.dispatch('tool.call', input, async () => ({result:'core'}))).toEqual({result:'core'})
  })

  test('a judge that let a plugin in before the others could be asked is not asked again', async () => {
    const plugins = [
      await fixture(`let asked = 0; export function register(on) {
        on('plugin.register', ($, e, next) => e.name === 'x' && ++asked > 1 ? {refuse:'counter asked twice'} : next(e));
      }`, 'counter'),
      await fixture(unloadedJudge('nobody'), 'jbad'),
      await fixture(`export function register(on) { on('tool.call', {tool:'Read'}, async ($, e, next) => ({deny:'x: denied'})); }`, 'x'),
    ]
    const { value, events } = runtime()
    await value.reconcile(plugins)
    expect(events).toEqual([jbadDidNotLoad])
    expect(await value.dispatch('tool.call', input, async () => ({result:'core'}))).toEqual({deny:'x: denied'})
  })

  test('a judge asked after the last build still sees the hooks of the judges that were asked before', async () => {
    const plugins = [
      await fixture(`export function register(on) { on('engine.create', async ($, e, next) => { const built = await next(e); return {...built, greeting: {read: async () => 'original'}}; }); }`, 'provider'),
      await fixture(`export function register(on) {
        on('plugin.register', ($, e, next) => next(e));
        on('greeting.read', async ($, e, next) => ({value:'from m'}));
      }`, 'm'),
      await fixture(`export function register(on) {
        on('plugin.register', async ($, e, next) => e.name === 'x' && await $.greeting.read({}) !== 'from m' ? {refuse:'j2 read the unhooked greeting'} : next(e));
        on('late.hello', async ($, e, next) => next(e));
      }`, 'j2'),
      await fixture(`export function register(on) { on('tool.call', {tool:'Read'}, async ($, e, next) => ({deny:'x: denied'})); }`, 'x'),
      await fixture(`export function register(on) { on('engine.create', async ($, e, next) => { const built = await next(e); return {...built, late: {hello: async () => 'hi'}}; }); }`, 'late'),
    ]
    const { value, events } = runtime()
    await value.reconcile(plugins)
    expect(events).toEqual([])
    expect(await value.dispatch('tool.call', input, async () => ({result:'core'}))).toEqual({deny:'x: denied'})
  })

  test('a user plugin whose engine.create withholds a noun does not load (official 2.1.329)', async () => {
    const plugins = [
      await fixture(`export function register(on) { on('engine.create', async ($, e, next) => { const built = await next(e); return {...built, greeting: {read: async () => 'original'}}; }); }`, 'provider'),
      await fixture(`export function register(on) {
        on('engine.create', async ($, e, next) => { const {greeting, ...built} = await next(e); return {...built}; });
        on('tool.call', {tool:'Read'}, async ($, e, next) => ({deny:'hide: denied'}));
      }`, 'hide'),
    ]
    const { value, events } = runtime()
    await value.reconcile([plugins[1]!, plugins[0]!])
    expect(events.map(event => event.plugin)).toEqual(['hide'])
    expect(events[0]!.message).toMatch(/engine\.create withheld \$\.\w+, added by (core|provider); it runs in the user tier/)
    expect(await value.dispatch('tool.call', input, async () => ({result:'core'}))).toEqual({result:'core'})
  })

  test.each([[['jbad', 'provider', 'consumer']], [['jbad', 'consumer', 'provider']]] as const)('a provider that a module that does not load would have refused keeps its consumer loaded (%p)', async order => {
    const sources = {
      jbad: unloadedJudge('provider'),
      provider: `export function register(on) { on('engine.create', async ($, e, next) => { const built = await next(e); return {...built, prov: {hello: async () => 1}}; }); }`,
      consumer: `export function register(on) { on('prov.hello', async ($, e, next) => next(e)); on('tool.call', {tool:'Read'}, async ($, e, next) => ({deny:'consumer: denied'})); }`,
    }
    const plugins = []
    for (const name of order) plugins.push(await fixture(sources[name], name))
    const { value, events } = runtime()
    await value.reconcile(plugins)
    expect(events).toEqual([jbadDidNotLoad])
    expect(await value.dispatch('tool.call', input, async () => ({result:'core'}))).toEqual({deny:'consumer: denied'})
  })

  test('a provider removed from the build takes its consumer with it', async () => {
    const provider = await fixture(`export function register(on) {
      on('engine.create', async ($, e, next) => { const built = await next(e); return {...built, nope: {hello: async () => 1}}; });
      on('other.event', async ($, e, next) => next(e));
    }`, 'provider')
    const consumer = await fixture(`export function register(on) { on('nope.hello', async ($, e, next) => next(e)); ${deny} }`, 'ue')
    const { value, events } = runtime()
    await value.reconcile([provider, consumer])
    expect(events.map(event => event.message)).toEqual([
      'hooks module did not load: the $ build failed (registered other.event, but no loaded plugin provides $.other)',
      'hooks module did not load: the $ build failed (registered nope.hello, but no loaded plugin provides $.nope)',
    ])
    expect(await value.dispatch('tool.call', input, async () => ({result:'core'}))).toEqual({result:'core'})
  })
})
