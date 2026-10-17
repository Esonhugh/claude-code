import {expect, test} from 'bun:test'
import {mkdtemp, writeFile, rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createModsRuntime} from './runtime.js'

test('aborted public stream bounds an author that never settles its pull', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-abort-grace-'))
  const runtime = createModsRuntime()
  const abort = new AbortController()
  let source: ReturnType<typeof runtime.stream> | undefined
  try {
    const entry = join(root, 'register.ts')
    await writeFile(entry, `export function register(on) {
      on('turn.step', async function* () {
        yield {kind:'text',index:0,text:'partial'};
        await new Promise(() => {});
      });
    }`)
    await runtime.reconcile([{name:'unsettled',storageId:'unsettled@inline',pluginRoot:root,entrypoints:[entry]}])
    let calls = 0
    const input = {turnId:'turn',index:0,model:'fake',messageCount:1}
    source = runtime.stream('turn.step', input, async function* () {
      calls++
      yield {kind:'text',index:0,text:'unexpected'}
      return {...input,answer:'unexpected',toolUses:[],stopReason:'end_turn',usage:null}
    }, {signal:abort.signal})
    expect(await source.next()).toMatchObject({done:false,value:{text:'partial'}})
    const pending = source.next().then(() => undefined, error => error)
    const outcome = source.result.then(() => undefined, error => error)
    abort.abort(new Error('bounded cancel'))
    expect(await pending).toBe(abort.signal.reason)
    expect(await outcome).toBe(abort.signal.reason)
    const failure = await source.return(undefined).then(() => undefined, error => error)
    // Cancellation must finish actual Worker teardown, even with no host call
    // available to reject the author's forever-pending Promise.
    if (failure !== undefined) expect(failure).toMatchObject({message:expect.stringContaining('aborted invocation')})
    expect(calls).toBe(0)
  } finally {
    await runtime.dispose()
    await rm(root,{recursive:true,force:true})
  }
}, 10_000)
