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
  const events: { plugin: string; stage: string; message: string }[] = []
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
    expect(events).toEqual([{ plugin: 'ue', stage: 'load', message: `hooks module did not load: the $ build failed (${reason})` }])
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
