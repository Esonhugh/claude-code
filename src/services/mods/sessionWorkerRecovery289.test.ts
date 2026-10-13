import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LoadedPlugin } from '../../types/plugin.js'
import * as secureStorage from '../../utils/secureStorage/index.js'
import { refreshPluginRuntimes } from '../../utils/plugins/cacheUtils.js'
import { createModsSession } from './session.js'
import { createModsRuntime, type ModDiagnostic, type ModPluginInput } from './runtime.js'
import type { ModRenderSite } from './ui.js'

const healthySource = `let n=0;export function register(on) {
  on('session.start', async ($, e, next) => { await $.clock.sleep(1); return next(e); });
  on('tool.call', {tool:'Status'}, () => ({result:++n}));
  on('ui.render', {component:'AbovePrompt'}, ($,e) => $.ui.resolve(e).Text({children:'OKB-BAND'}));
}`
const culpritSource = `export function register(on) {
  on('session.start', async ($) => { await $.clock.now(); for(;;){} });
}`

async function plugin(root: string, name: string, source: string): Promise<LoadedPlugin> {
  const path = await mkdtemp(join(root, name + '-'))
  await writeFile(join(path, 'register.ts'), source)
  return {
    name, manifest: { name }, path, source: name + '@inline', repository: name + '@inline', enabled: true,
    hookModules: [{ configPath: join(path, 'hooks.json'), paths: ['./register.ts'] }],
  }
}

function input(plugin: LoadedPlugin): ModPluginInput {
  return { name: plugin.name, storageId: plugin.source, pluginRoot: plugin.path, entrypoints: [join(plugin.path, 'register.ts')] }
}

test('the real plugin refresh waits for known Worker recovery, retries the culprit, and reports its unload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-session-worker-recovery-'))
  const storage = spyOn(secureStorage, 'getSecureStorage').mockReturnValue({
    read: () => ({}), update: () => { throw Error('unexpected secure storage write') },
  } as unknown as ReturnType<typeof secureStorage.getSecureStorage>)
  const events: ModDiagnostic[] = []
  const notices: { plugin: string; text: string; to: string }[] = []
  const held = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let holdRecovery = false
  let culpritStarts = 0
  const host = createModsSession({
    isTrusted: true,
    getSettings: () => ({ userSettings: null, flagSettings: null, policySettings: null, hookPolicy: { managedOnly: false, allDisabled: false } }),
    loadPlugins: async () => [],
    onDiagnostic: event => events.push(event),
    createRuntime(options) {
      const runtime = createModsRuntime(options)
      runtime.registerHostHook({
        plugin: 'recovery-observer', tier: 'prepend', registration: { id: 1, event: 'clock.now', hasCatch: false },
        async invoke(args, next) {
          if (next.origin.plugin === 'loopa') culpritStarts++
          return next(args)
        },
      })
      runtime.registerHostHook({
        plugin: 'recovery-gate', tier: 'prepend', registration: { id: 2, event: 'clock.sleep', hasCatch: false },
        async invoke(args, next) {
          if (holdRecovery && next.origin.plugin === 'okb') { held.resolve(); await release.promise }
          return next(args)
        },
      })
      return runtime
    },
  })
  let pending: Promise<{ error?: unknown }> | undefined
  try {
    const healthy = await plugin(root, 'okb', healthySource)
    const culprit = await plugin(root, 'loopa', culpritSource)
    await host.bind({ cwd: root, sessionId: 'reload-recovery', surface: 'terminal', isInteractive: true }, undefined, {
      uiLog(plugin, text, to) { notices.push({ plugin, text, to }) },
    })
    await host.refresh([healthy, culprit]).catch(() => {})
    await host.runtime!.settle()
    expect(culpritStarts).toBe(1)
    expect(await host.runtime!.dispatch('tool.call', { tool: 'Status' }, async () => ({ result: 'core' }))).toEqual({ result: 1 })
    const start = events.length
    holdRecovery = true
    let completed = false
    pending = refreshPluginRuntimes([healthy, culprit]).then(() => ({}), error => ({ error }))
    void pending.then(() => { completed = true })
    await held.promise
    expect(completed).toBe(false)
    release.resolve()
    expect(await pending).toEqual({})
    expect(culpritStarts).toBe(2)
    expect(await host.runtime!.dispatch('tool.call', { tool: 'Status' }, async () => ({ result: 'core' }))).toEqual({ result: 1 })
    expect(events.slice(start).find(event => event.stage === 'worker')?.workerFault).toMatchObject({ cause: 'heartbeat', culprit: { plugin: 'loopa' } })
    expect(events.slice(start).filter(event => event.stage === 'refresh' || event.stage === 'recovery')).toEqual([])
    expect(notices).toEqual([
      { plugin: 'loopa', text: 'loopa was unloaded: it crashed the hooks worker', to: 'transcript' },
      { plugin: 'loopa', text: 'loopa was unloaded: it crashed the hooks worker', to: 'transcript' },
    ])
  } finally {
    release.resolve()
    await pending
    await host.dispose()
    storage.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
}, 16000)

test('a failed real recovery paint rejects reconcile with the recovery error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-worker-recovery-paint-'))
  const events: ModDiagnostic[] = []
  const runtime = createModsRuntime({ onDiagnostic: event => events.push(event) })
  const failure = Error('recovery consumer paint failed')
  let site: ModRenderSite | undefined
  try {
    await runtime.bind({ cwd: root, sessionId: 'recovery-paint', surface: 'terminal', isInteractive: true })
    site = await runtime.ui.mount({ surface: 'terminal', component: 'AbovePrompt', requestId: 'recovery-paint', props: {} }, {
      surface: 'terminal',
      render(tree) { if (JSON.stringify(tree).includes('OKB-BAND')) throw failure },
      unmount() {},
    })
    const healthy = await plugin(root, 'okb', healthySource)
    const culprit = await plugin(root, 'loopa', culpritSource)
    const outcome = await runtime.reconcile([input(healthy), input(culprit)]).then(() => ({}), error => ({ error }))
    expect(outcome).toEqual({ error: failure })
    expect(events.find(event => event.stage === 'worker')?.workerFault).toMatchObject({ cause: 'heartbeat', culprit: { plugin: 'loopa' } })
    expect(events.filter(event => event.stage === 'recovery').map(event => event.message)).toEqual([failure.message])
  } finally {
    await site?.dispose()
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 10000)

test('an actual unknown Worker exit during admission waits for the restored generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-worker-recovery-admission-'))
  const RealWorker = globalThis.Worker
  const workers: Worker[] = []
  globalThis.Worker = class extends RealWorker {
    constructor(url: string | URL, options?: WorkerOptions) { super(url, options); workers.push(this) }
  } as typeof Worker
  const died = Promise.withResolvers<void>()
  const held = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const events: ModDiagnostic[] = []
  const runtime = createModsRuntime({ onDiagnostic(event) { events.push(event); if (event.stage === 'worker') died.resolve() } })
  let admissions = 0
  runtime.registerHostHook({
    plugin: 'admission-gate', tier: 'prepend', registration: { id: 1, event: 'plugin.register', hasCatch: false },
    async invoke(args, next) {
      if (++admissions === 1) { held.resolve(); await release.promise }
      return next(args)
    },
  })
  let pending: Promise<{ error?: unknown }> | undefined
  try {
    await runtime.bind({ cwd: root, sessionId: 'recovery-admission', surface: null, isInteractive: false })
    const healthy = await plugin(root, 'okb', healthySource)
    pending = runtime.reconcile([input(healthy)]).then(() => ({}), error => ({ error }))
    await held.promise
    workers.at(-1)!.terminate()
    await died.promise
    release.resolve()
    expect(await pending).toEqual({})
    expect(await runtime.dispatch('tool.call', { tool: 'Status' }, async () => ({ result: 'core' }))).toEqual({ result: 1 })
    expect(events.find(event => event.stage === 'worker')?.workerFault).toMatchObject({ cause: 'exit' })
    expect(events.find(event => event.stage === 'worker')?.workerFault).not.toHaveProperty('culprit')
    expect(events.filter(event => event.stage === 'recovery')).toEqual([])
  } finally {
    release.resolve()
    await pending
    await runtime.dispose()
    globalThis.Worker = RealWorker
    await rm(root, { recursive: true, force: true })
  }
})
