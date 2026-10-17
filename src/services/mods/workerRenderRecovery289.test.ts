import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createModsRuntime, type ModDiagnostic, type ModPluginInput } from './runtime.js'
import type { ModRenderSite } from './ui.js'

for (const stage of ['session.start', 'tool.call'] as const) {
  test(`${stage} CPU death restores the independent AbovePrompt consumer without input`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'mods-band-recovery-'))
    const diagnostics: ModDiagnostic[] = []
    const died = Promise.withResolvers<void>()
    const frames: { tree: unknown; drawing: number }[] = []
    const runtime = createModsRuntime({
      onDiagnostic(event) {
        diagnostics.push(event)
        if (event.stage === 'worker') died.resolve()
      },
    })
    let site: ModRenderSite | undefined
    const plugin = async (name: string, source: string): Promise<ModPluginInput> => {
      const dir = await mkdtemp(join(root, name + '-'))
      const entry = join(dir, 'register.ts')
      await writeFile(entry, source)
      return { name, storageId: name + '@inline', pluginRoot: dir, entrypoints: [entry] }
    }
    try {
      await runtime.bind({ cwd: root, surface: 'terminal', isInteractive: true, sessionId: 'band-recovery' })
      const healthy = await plugin('okb', `export function register(on) {
        on('ui.render', {component:'AbovePrompt'}, ($, e) => {
          const {Box, Text} = $.ui.resolve(e);
          return Box({children:[Text({children:'OKB-BAND'})]});
        });
        on('tool.call', {tool:'Status'}, () => ({result:'okb alive'}));
      }`)
      const bad = await plugin('loopa', stage === 'session.start'
        ? "export function register(on) { on('session.start', () => { for(;;){} }); }"
        : "export function register(on) { on('tool.call', ($, e, next) => { if(e.command==='spin')for(;;){}; return next(e); }); }")
      if (stage === 'tool.call') await runtime.reconcile([healthy, bad])
      site = await runtime.ui.mount({ surface: 'terminal', component: 'AbovePrompt', requestId: 'above-prompt', props: {} }, {
        surface: 'terminal',
        render(tree, drawing) { frames.push({ tree, drawing }) },
        unmount() {},
      })
      const before = frames.at(-1)!
      const operation = stage === 'session.start'
        ? runtime.reconcile([healthy, bad])
        : runtime.dispatch('tool.call', { tool: 'Bash', tool_use_id: 'band-spin', command: 'spin' }, async () => ({ result: 'core' }))
      const result = operation.then(value => ({ value }), error => ({ error }))
      await died.promise
      await result
      await runtime.settle()
      expect(diagnostics.find(event => event.stage === 'worker')?.workerFault).toMatchObject({
        cause: 'heartbeat', culprit: { plugin: 'loopa' },
      })
      expect(runtime.hasHooks('ui.render')).toBe(true)
      expect(frames.at(-1)!.drawing).toBeGreaterThan(before.drawing)
      expect(frames.at(-1)!.tree).toMatchObject({ type: 'Box', children: [{ type: 'Text', children: ['OKB-BAND'] }] })
      expect(await runtime.dispatch('tool.call', { tool: 'Status' }, async () => ({ result: 'core' }))).toEqual({ result: 'okb alive' })
      expect(diagnostics.filter(event => event.stage === 'recovery' || event.stage === 'ui.render')).toEqual([])
    } finally {
      await site?.dispose()
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 10000)
}
