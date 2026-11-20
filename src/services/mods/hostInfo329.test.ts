import { expect, spyOn, test } from 'bun:test'
import { propagation } from '@opentelemetry/api'
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { machine, release, tmpdir, type } from 'node:os'
import { join } from 'node:path'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
import { createModsRuntime } from './runtime.js'

test('host reads, hookEnv and message pages are reachable from a loaded plugin', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(),'mods-329-host-')))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = root
  const messages = [createUserMessage({content:'first'}),createAssistantMessage({content:'last'})]
  const runtime = createModsRuntime({services:{rawMessages:()=>messages}})
  const traceparent = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01'
  const injection = spyOn(propagation, 'inject').mockImplementation((_context, carrier) => {
    Object.assign(carrier as object, {traceparent, baggage:'not a hook variable'})
  })
  try {
    const entry = join(root,'plugin.mjs')
    await writeFile(entry, `export function register(on) {
      on('session.info', async ($,e,next) => {const r = await next(e);return {value:{...r.value,agentType:'inspected'}}});
      on('tool.call', async $ => {
        const last = await $.session.messages({last:2});
        return {result:{last, after:await $.session.messages({after:last[0].uuid}), missing:await $.session.messages({after:'absent'}),
          info:await $.session.info(), machine:await $.session.machine(), env:await $.process.hookEnv()}};
      });
    }`)
    await runtime.bind({cwd:root,sessionId:'329-host',isInteractive:false,surface:null})
    await runtime.reconcile([{name:'check',storageId:'check@fixture',entrypoints:[entry],pluginRoot:root}])
    const {result} = await runtime.dispatch('tool.call',{},async()=>({result:null})) as {result:{last:{uuid:string}[]; after:{uuid:string}[]; missing:{deny:string}; info:unknown;machine:unknown;env:Record<string,string>}}
    expect(result.info).toMatchObject({agentType:'inspected',transcriptPath:expect.any(String),isHosted:false})
    expect(result.machine).toMatchObject({sysname:type(),release:release(),machine:machine(),runtimes:expect.any(Array)})
    expect(result.env).toMatchObject({CLAUDE_PID:String(process.pid),CLAUDE_CODE_SESSION_ID:'329-host',CLAUDE_PLUGIN_ROOT:root,CLAUDE_CODE_SESSION_ATTENDED:'0'})
    expect(result.env).not.toHaveProperty('PATH')
    expect(result.env.TRACEPARENT).toBe(traceparent)
    expect(result.env).not.toHaveProperty('baggage')
    expect((await stat(result.env.CLAUDE_PLUGIN_DATA!)).isDirectory()).toBe(true)
    expect(result.last.map(row=>row.uuid)).toEqual(messages.map(row=>row.uuid))
    expect(result.after.map(row=>row.uuid)).toEqual([messages[1]!.uuid])
    expect(result.missing.deny).toContain('absent')
  } finally {
    injection.mockRestore()
    await runtime.dispose()
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(root,{recursive:true,force:true})
  }
})
