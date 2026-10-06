import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { setOriginalCwd } from '../../bootstrap/state.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { registerAsyncAgent } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { GENERAL_PURPOSE_AGENT } from '../../tools/AgentTool/built-in/generalPurposeAgent.js'
import { asAgentId } from '../../types/ids.js'
import { enableConfigs } from '../../utils/config.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { createModsRuntime, type ModsRuntime } from './runtime.js'

let root: string
let state: ReturnType<typeof getDefaultAppState>
const runtimes: ModsRuntime[] = []
const keys = ['HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS']
let saved: (string | undefined)[]
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mods-spawn-bound-')))
  saved = keys.map(key => process.env[key])
  for (const key of keys) delete process.env[key]
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  process.env.XDG_CONFIG_HOME = join(root, 'xdg')
  process.env.XDG_CACHE_HOME = join(root, 'cache')
  process.env.ANTHROPIC_API_KEY = 'owned-spawn-capacity-dummy'
  setOriginalCwd(root)
  enableConfigs()
  resetSettingsCache()
  state = getDefaultAppState()
})
afterEach(async () => {
  for (const task of Object.values(state.tasks)) task.status = 'completed'
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
  resetSettingsCache()
  keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i] })
  await rm(root, { recursive: true, force: true })
})
async function plugin(name: string) {
  const entry = join(root, name + '.ts')
  await writeFile(entry, [
    'export function register(on) {',
    'on("command.run", async ($, e, next) => {',
    'if (e.command !== ' + JSON.stringify(name) + ') return next(e);',
    'const results=[]; let error;',
    'try { for(let i=0;i<(e.count??1);i++) results.push(await $.agent.spawn({prompt:e.mode??"running",subagentType:"general-purpose"})); }',
    'catch(value) {error=String(value.message);}',
    'return {text:JSON.stringify({results,...(error?{error}:{})})};',
    '}); }',
  ].join('\n'))
  return { name, storageId: name + '@test', pluginRoot: root, entrypoints: [entry] }
}
async function fixture(names = ['author']) {
  let calls = 0
  const launch = Promise.withResolvers<void>()
  const runtime = createModsRuntime({ services: {
    tasks: () => state.tasks,
    agentSpawn: async (input, _snapshot, signal, _plugin, leftRunning) => {
      signal.throwIfAborted()
      calls++
      if (input.prompt === 'throw') throw new Error('launch failed')
      if (input.prompt === 'deny') return { deny: 'launch denied' }
      if (input.prompt === 'nonasync') return { model: 'model', agentId: 'remote-agent' }
      if (input.prompt === 'pending') await launch.promise
      const agentId = asAgentId('agent-' + calls)
      // Real task registration and a distinct task ID exercise the host registry.
      registerAsyncAgent({agentId,description:'capacity',prompt:'capacity',selectedAgent:GENERAL_PURPOSE_AGENT,setAppState:updater => {state=updater(state)},spawnDepth:1})
      const task = state.tasks[agentId]!
      delete state.tasks[agentId]
      state.tasks['task-' + agentId] = {...task,id:'task-' + agentId}
      leftRunning?.(agentId)
      return { model: 'model', agentId }
    },
  } })
  runtimes.push(runtime)
  await runtime.bind({cwd:root,surface:null,isInteractive:false,sessionId:'owned'})
  const plugins = await Promise.all(names.map(plugin))
  await runtime.reconcile(plugins)
  return { runtime, plugins, launch, calls: () => calls,
    invoke: async (name = names[0]!, count = 1, mode = 'running', signal?: AbortSignal) => {
      const result = await runtime.dispatch('command.run', {command:name,count,mode}, async () => ({}), {signal}) as {text:string}
      return JSON.parse(result.text) as {results: ({model:string;agentId?:string}|{deny:string})[];error?:string}
    },
  }
}

for (const value of [undefined, '0', '-2', '1.5', '2agents', '2e1', '', '9'.repeat(400)]) {
  test('default 20 spawns for invalid or missing limit ' + JSON.stringify(value), async () => {
    if (value !== undefined) process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = value
    const f = await fixture()
    const result = await f.invoke('author', 21)
    expect(result.results).toHaveLength(20)
    expect(result.error).toBe('author: $.agent.spawn refused: 20 spawns are running at once')
    expect(f.calls()).toBe(20)
  })
}

test('plugin capacity survives launch receipts, captured callers, reload and another plugin', async () => {
  process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = '  +02 '
  const f = await fixture(['author', 'other'])
  expect((await f.invoke('author', 2)).results).toHaveLength(2)
  const snapshot = f.runtime.capture()
  try {
    const result = await snapshot.dispatch('command.run',{command:'author'},async()=>({})) as {text:string}
    expect(JSON.parse(result.text).error).toBe('author: $.agent.spawn refused: 2 spawns are running at once')
  } finally { snapshot.release() }
  await f.runtime.reconcile(f.plugins.map(input => ({...input,options:{revision:2}})))
  expect((await f.invoke()).error).toBe('author: $.agent.spawn refused: 2 spawns are running at once')
  expect((await f.invoke('other', 2)).results).toHaveLength(2)
  expect((await f.invoke('other')).error).toBe('other: $.agent.spawn refused: 2 spawns are running at once')
  expect(f.calls()).toBe(4)
})

for (const status of ['completed', 'failed', 'killed', 'evicted'] as const) {
  test('only terminal or evicted local task releases capacity: ' + status, async () => {
    process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = '1'
    const f = await fixture()
    const first = await f.invoke()
    expect((await f.invoke()).error).toBe('author: $.agent.spawn refused: 1 spawns are running at once')
    const receipt = first.results[0]!
    if ('deny' in receipt) throw new Error('Expected a launched agent')
    const id = 'task-' + receipt.agentId
    state.tasks[id]!.status = 'pending'
    await delay(200)
    expect((await f.invoke()).error).toBe('author: $.agent.spawn refused: 1 spawns are running at once')
    if (status === 'evicted') delete state.tasks[id]
    else state.tasks[id]!.status = status
    await delay(200)
    expect((await f.invoke()).results).toHaveLength(1)
    expect(f.calls()).toBe(2)
  })
}

test('failed, denied and nonasync launches release their reservations immediately', async () => {
  process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = '1'
  const f = await fixture()
  expect((await f.invoke('author', 1, 'throw')).error).toBe('launch failed')
  expect((await f.invoke('author', 1, 'deny')).results).toEqual([{deny:'launch denied'}])
  expect((await f.invoke('author', 1, 'nonasync')).results).toEqual([{model:'model',agentId:'remote-agent'}])
  expect((await f.invoke()).results).toHaveLength(1)
  expect(f.calls()).toBe(4)
})

test('reserve before launch is acknowledged and detach completed launches from caller abort', async () => {
  process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = '1'
  const f = await fixture()
  const controller = new AbortController()
  const pending = f.invoke('author', 1, 'pending', controller.signal)
  try {
    while (f.calls() === 0) await delay(10)
    expect((await f.invoke()).error).toBe('author: $.agent.spawn refused: 1 spawns are running at once')
    f.launch.resolve()
    expect((await pending).results).toHaveLength(1)
    controller.abort()
    expect((await f.invoke()).error).toBe('author: $.agent.spawn refused: 1 spawns are running at once')
    expect(f.calls()).toBe(1)
  } finally {
    f.launch.resolve()
    await pending.catch(() => {})
  }
})
