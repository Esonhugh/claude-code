import {expect, test} from 'bun:test'
import {mkdtemp, writeFile, rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createModsRuntime, type ModDiagnostic} from './runtime.js'

// Like official, an aborted stream whose author never settles its pull is
// abandoned on its own after the grace; the shared Worker and its other mods live on.
test('aborted turn.step that never settles expires alone without killing the shared Worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-abort-overrun-'))
  const events: ModDiagnostic[] = []
  const runtime = createModsRuntime({onDiagnostic: event => { events.push(event) }})
  const abort = new AbortController()
  try {
    const stuck = join(root, 'stuck.ts'), survivor = join(root, 'survivor.ts')
    await writeFile(stuck, `export function register(on) {
      on('turn.step', async function* () {
        yield {kind:'text',index:0,text:'partial'};
        await new Promise(() => {});
      });
    }`)
    await writeFile(survivor, `let n = 0; export function register(on) { on('tool.call', () => ({result: ++n})) }`)
    await runtime.reconcile([
      {name:'stuck',storageId:'stuck@inline',pluginRoot:root,entrypoints:[stuck]},
      {name:'survivor',storageId:'survivor@inline',pluginRoot:root,entrypoints:[survivor]},
    ])
    const call = () => runtime.dispatch('tool.call', {tool:'Bash',tool_use_id:'t',command:'x'}, async () => ({result:'core'}))
    expect(await call()).toMatchObject({result:1})
    const input = {turnId:'turn',index:0,model:'fake',messageCount:1}
    const source = runtime.stream('turn.step', input, async function* () {
      yield {kind:'text',index:0,text:'unexpected'}
      return {...input,answer:'unexpected',toolUses:[],stopReason:'end_turn',usage:null}
    }, {signal:abort.signal})
    expect(await source.next()).toMatchObject({done:false,value:{text:'partial'}})
    const pending = source.next().then(() => undefined, error => error)
    abort.abort(new Error('bounded cancel'))
    expect(await pending).toBe(abort.signal.reason)
    const start = performance.now()
    const closed = await source.return(undefined).then(() => undefined, error => error)
    if (closed !== undefined) expect(String(closed)).toContain('did not settle')
    expect(performance.now() - start).toBeLessThan(6500)
    await new Promise(resolve => setTimeout(resolve, 1500))
    expect(events.filter(event => event.stage === 'worker')).toEqual([])
    // Same Worker: the survivor's module state is intact.
    expect(await call()).toMatchObject({result:2})
  } finally {
    await runtime.dispose()
    await rm(root,{recursive:true,force:true})
  }
}, 15_000)
