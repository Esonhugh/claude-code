import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createModsRuntime, type ModDiagnostic } from './runtime.js'
import type { ModRenderSite } from './ui.js'

test('a second Worker crash during recovery still restores survivor hooks and timers', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mods-recovery-chain-')))
  const diagnostics: ModDiagnostic[] = []
  const notices: { plugin: string; text: string; to: string }[] = []
  const runtime = createModsRuntime({ onDiagnostic: event => diagnostics.push(event), services: {
    uiLog: (plugin, text, to) => { notices.push({ plugin, text, to }) },
  } })
  let site: ModRenderSite | undefined
  let paint = ''
  try {
    const inputs = []
    for (const name of ['survivor', 'loopa', 'loopb']) {
      const folder = join(root, name)
      await mkdir(folder)
      const entry = join(folder, 'register.ts')
      await writeFile(entry, name === 'survivor' ? `let ticks=0;export function register(on) {
        on('session.start', ($,e,next) => { $.clock.after(0, () => {ticks++}); return next(e) });
        on('tool.call', () => ({result:ticks}));
        on('ui.render', {component:'AbovePrompt'}, ($,e) => $.ui.resolve(e).Text({children:'RECOVERY_BAND'}));
      }` : `export function register(on) { on('session.start', () => {for(;;){}}); }`)
      inputs.push({ name, storageId: name + '@test', pluginRoot: folder, entrypoints: [entry] })
    }
    await runtime.bind({ cwd: root, sessionId: 'double-crash', surface: 'terminal', isInteractive: true })
    site = await runtime.ui.mount({ surface: 'terminal', component: 'AbovePrompt', requestId: 'recovery-band', props: {} }, {
      surface: 'terminal', render(tree) { paint = JSON.stringify(tree) }, unmount() {},
    })
    const outcome = await runtime.reconcile(inputs).then(() => ({}), error => ({ error }))
    await runtime.settle()
    expect(await runtime.dispatch('tool.call', {}, async () => ({ result: 'core' }))).toEqual({ result: 1 })
    expect(outcome).toEqual({})
    expect(paint).toContain('RECOVERY_BAND')
    expect(diagnostics.filter(event => event.stage === 'worker').map(event => event.workerFault?.culprit?.plugin))
      .toEqual(['loopa', 'loopb'])
    expect(diagnostics.filter(event => event.stage === 'recovery')).toEqual([])
    expect(notices).toEqual(['loopa', 'loopb'].map(plugin => ({
      plugin, text: `${plugin} was unloaded: it crashed the hooks worker`, to: 'transcript',
    })))
  } finally { await site?.dispose(); await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
}, 20000)
