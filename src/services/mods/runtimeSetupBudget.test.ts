import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModEnvironment } from './environment.js'
import { createModsRuntime } from './runtime.js'

// Official 2.1.292 HookBudget counts only the hook's own code. A held host
// setup RPC must not spend that budget before the Worker enters the hook.
test.each([false, true])('Worker setup excludes host preparation from own time: stream=%s', async streaming => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mods-setup-budget-')))
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({ onDiagnostic: event => diagnostics.push(event), services: {
    uiPresentation: () => ({ columns: 80, rows: 24, isFullscreen: true,
      composerEmpty: true, hasDialog: false, keyboardOwned: false }),
  } })
  const allowance = streaming ? 10_000 : 50
  const clocks = new Map<ReturnType<typeof setTimeout>, () => void>()
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout
  let setSpy: ReturnType<typeof spyOn> | undefined, clearSpy: ReturnType<typeof spyOn> | undefined
  let pending: Promise<unknown> | undefined
  try {
    const entry = join(root, 'register.ts')
    await writeFile(entry, `export function register(on) {
      on('session.start', async ($, e, next) => { await $.ui.open({id:'budget'}); return next(e) });
      on('ui.render', {component:'Pane'}, ($, e) => $.ui.resolve(e).Text({children:'budget'}));
      ${streaming
        ? "on('turn.step', async function* ($, e, next) { yield {kind:'text',index:0,text:'plugin'}; return {...e,answer:'plugin',toolUses:[],stopReason:'end_turn',usage:null} });"
        : "on('prompt.edit', ($, e, next) => ({text:'plugin:'+next.budget.ms,cursor:0}));"}
    }`)
    await runtime.bind({ cwd: root, surface: 'terminal', isInteractive: true, sessionId: 'setup-budget' })
    await runtime.reconcile([{ name: 'budget-owner', storageId: 'budget-owner@test', pluginRoot: root, entrypoints: [entry] }])
    await runtime.dispatch('session.start', {cwd:root}, async input => input)
    const environment = (runtime.ui.getSnapshot()[0]!.owner as { environment: ModEnvironment }).environment
    const setUiAccess = environment.setUiAccess.bind(environment)
    environment.setUiAccess = async allowed => {
      entered.resolve()
      await release.promise
      await setUiAccess(allowed)
    }
    setSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay?: number, ...args: unknown[]) => {
      if (delay !== allowance) return originalSet(callback, delay, ...args)
      const handle = { unref() { return this } } as ReturnType<typeof setTimeout>
      clocks.set(handle, callback)
      return handle
    }) as typeof setTimeout)
    clearSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(handle => {
      if (clocks.delete(handle as ReturnType<typeof setTimeout>)) return
      originalClear(handle)
    })
    if (streaming) {
      const flow = runtime.stream('turn.step', { turnId: 'budget-turn', index: 0, model: 'haiku', messageCount: 1 }, async function* (input) {
        yield {kind:'text',index:0,text:'core'}
        return {...input,answer:'core',toolUses:[],stopReason:'end_turn',usage:null}
      })
      pending = Promise.all([(async () => { const first = await flow.next(); await flow.next(); return first })(), flow.result])
        .then(([first, result]) => ({first, result}), error => ({error}))
    } else {
      pending = runtime.dispatch('prompt.edit', {origin:{kind:'composer'},text:'',cursor:0,start:0,end:0,inputText:'x'}, async () => ({text:'core',cursor:0}))
        .then(value => value, error => ({error}))
    }
    await entered.promise
    // Expire every own-time timer the dispatcher left active during the held
    // host RPC. No wall-clock delay, larger budget or scheduler speed needed.
    for (const callback of [...clocks.values()]) callback()
    release.resolve()
    const result = await pending
    if (streaming) expect(result).toMatchObject({ first: {done:false,value:{text:'plugin'}}, result:{answer:'plugin'} })
    else expect(result).toEqual({text:'plugin:50',cursor:0})
    expect(diagnostics).toEqual([])
  } finally {
    release.resolve()
    await pending?.catch(() => {})
    setSpy?.mockRestore()
    clearSpy?.mockRestore()
    await runtime.dispose()
    await rm(root, {recursive:true,force:true})
  }
})
