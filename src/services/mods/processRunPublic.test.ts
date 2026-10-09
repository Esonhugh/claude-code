import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime } from './runtime.js'

let root: string
const runtimes: ReturnType<typeof createModsRuntime>[] = []
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'mods-public-run-'))) })
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  await rm(root, { recursive: true, force: true })
})
async function invoke(argv: string[], timeoutMs?: number) {
  const name = 'process-public'
  const pluginRoot = join(root, name)
  await mkdir(pluginRoot)
  const entry = join(pluginRoot, 'register.ts')
  await writeFile(entry, `export function register(on) {
    on('tool.call', async $ => {
      try {return {result:await $.process.run(${JSON.stringify(argv)},${JSON.stringify({ timeoutMs })})}}
      catch(error){return {result:{name:error.name,message:error.message}}}
    });
  }`)
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({ onDiagnostic: event => diagnostics.push(event) })
  runtimes.push(runtime)
  await runtime.bind({ cwd: root, sessionId: 'test', surface: 'terminal', isInteractive: true })
  await runtime.reconcile([{ name, storageId: name + '@test', pluginRoot, entrypoints: [entry] }])
  expect(diagnostics).toEqual([])
  const result = await runtime.dispatch('tool.call', { tool: 'Read', tool_use_id: 'run-test' }, async () => ({ result: 'unexpected core' }))
  expect(diagnostics).toEqual([])
  return result
}
test('real Worker public run timeout uses the official HooksError command and budget message', async () => {
  expect(await invoke([process.execPath, '-e', 'setTimeout(()=>{},1000)'], 20)).toEqual({ result: {
    name: 'HooksError', message: `process-public: $.process.run(${process.execPath}) aborted: still running after 20ms`,
  } })
})
test('real Worker public run startup failure uses HooksError and preserves errno in its message', async () => {
  const executable = join(root, 'missing')
  const result = await invoke([executable]) as { result: { name: string; message: string } }
  expect(result.result.name).toBe('HooksError')
  expect(result.result.message).toStartWith(`process-public: $.process.run(${executable}) failed to start: ENOENT:`)
})
