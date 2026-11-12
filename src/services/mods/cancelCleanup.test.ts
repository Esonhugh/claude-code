import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime } from './runtime.js'

let root: string
const runtimes: ReturnType<typeof createModsRuntime>[] = []
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'mods-cancel-cleanup-')) })
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose())); await rm(root, { recursive: true, force: true }) })

test('a cancelled hook can still close its pane and redraw in finally', async () => {
  const opened = Promise.withResolvers<void>()
  const logs: string[] = []
  const runtime = createModsRuntime({ services: {
    uiPresentation: () => ({ columns: 160, rows: 40, isFullscreen: true, composerEmpty: true, hasDialog: false, keyboardOwned: false }),
    uiLog: (_plugin, text) => { logs.push(text); if (text === 'opened') opened.resolve() },
  } })
  runtimes.push(runtime)
  await runtime.bind({ cwd: root, sessionId: 'test', surface: 'terminal', isInteractive: true })
  const pluginRoot = join(root, 'holder'); await mkdir(pluginRoot)
  const entry = join(pluginRoot, 'register.ts')
  await writeFile(entry, `export function register(on) {
    on('tool.call', async ($, e, next) => {
      try {
        await $.ui.open({ id: 'hold', focus: true })
        $.ui.log('opened', { to: 'debug' })
        await new Promise(resolve => next.signal.addEventListener('abort', resolve, { once: true }))
      } finally {
        try { await $.ui.close({ id: 'hold' }); await $.ui.invalidate('ui.render'); $.ui.log('closed', { to: 'debug' }) }
        catch (error) { $.ui.log('cleanup failed: ' + error.message, { to: 'debug' }) }
      }
      return { deny: 'interrupted' }
    })
    on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'held' }))
  }`)
  await runtime.reconcile([{ name: 'holder', storageId: 'holder@test', pluginRoot, entrypoints: [entry] }])
  const stop = new AbortController()
  const pending = runtime.dispatch('tool.call', {}, async () => ({ result: 'core' }), { signal: stop.signal }).catch(() => undefined)
  await opened.promise
  expect(runtime.ui.getSnapshot().map(pane => pane.id)).toEqual(['hold'])
  stop.abort(new Error('interrupted'))
  await pending
  await runtime.settle()
  expect(logs).toEqual(['opened', 'closed'])
  expect(runtime.ui.getSnapshot()).toEqual([])
})
