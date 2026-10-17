import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime } from './runtime.js'
import type { ModEnvironment } from './environment.js'

const presentation = { columns: 160, rows: 40, isFullscreen: true,
  composerEmpty: true, hasDialog: false, keyboardOwned: false }

test('an admitted press survives a redraw while it waits for access on the retargeted drawing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-retarget-'))
  let armed = false, retargeting = false, pauses = 0, pending: Promise<unknown> | undefined
  const gates = [0, 1].map(() => ({ entered: Promise.withResolvers<void>(), resume: Promise.withResolvers<void>() }))
  const runtime = createModsRuntime({ services: { uiPresentation: () => presentation,
    uiLog: (_plugin, text) => { if (text === 'enter core') armed = true } } })
  try {
    const entry = join(root, 'register.ts')
    await writeFile(entry, `let cached,hidden=false,count=0;export function register(on){
      on('session.start',async($,e,next)=>{await $.ui.open({id:'first'});await $.ui.open({id:'second'});return next(e)});
      on('ui.render',{component:'Pane'},($,e)=>{const {Button,Text}=$.ui.resolve(e);
        cached??=Button({key:'save',label:'Save',onPress:()=>{count++}});
        return hidden && e.requestId==='first' ? Text({children:'removed'}) : cached});
      on('ui.press',async($,e,next)=>{await $.ui.log('enter core');return next(e)});
      on('command.run',{command:'hide'},()=>{hidden=true;return {}});
      on('tool.call',{tool:'ReadCount'},()=>({result:{count}}));
    }`)
    await runtime.bind({ cwd: root, surface: 'terminal', isInteractive: true, sessionId: 'retarget' })
    await runtime.reconcile([{ name: 'retarget-owner', storageId: 'retarget-owner@test', pluginRoot: root, entrypoints: [entry] }])
    const before = runtime.ui.getSnapshot().find(pane => pane.id === 'first')!
    const environment = (before.owner as { environment: ModEnvironment }).environment
    const setUiAccess = environment.setUiAccess.bind(environment)
    // Pause the admitted press on its original drawing, then on the retargeted one. Renders in
    // between also grant access, so the second pause only arms once the first is released.
    environment.setUiAccess = async allowed => {
      await setUiAccess(allowed)
      if (armed && (pauses === 0 || retargeting && pauses === 1)) {
        const gate = gates[pauses++]!
        gate.entered.resolve()
        await gate.resume.promise
      }
    }
    pending = runtime.ui.interact(before.id, before.drawing!, (before.tree as any).press, 'press', 'save')
      .then(value => ({ value }), error => ({ error: String(error?.message) }))
    await gates[0]!.entered.promise
    await runtime.dispatch('command.run', { command: 'hide', args: '', origin: { kind: 'composer' } }, async () => ({}))
    await runtime.ui.render({ ...presentation, rows: 41 })
    retargeting = true
    gates[0]!.resume.resolve()
    await gates[1]!.entered.promise
    await runtime.ui.render({ ...presentation, rows: 42 })
    gates[1]!.resume.resolve()
    expect(await pending).toEqual({ value: { element: 'save' } })
    const count = await runtime.dispatch('tool.call', { tool: 'ReadCount' }, async () => ({ result: null })) as any
    expect(count.result).toEqual({ count: 1 })
  } finally {
    for (const gate of gates) gate.resume.resolve()
    await pending
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
