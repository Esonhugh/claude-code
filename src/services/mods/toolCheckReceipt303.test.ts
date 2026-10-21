import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime } from './runtime.js'

let root: string | undefined
let runtime: ReturnType<typeof createModsRuntime> | undefined
afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
  if (root) await rm(root, { recursive: true, force: true })
})

test('tool.check keeps setting and decider and drops a hook ceiling', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mods-check-')))
  const entry = join(root, 'register.mjs')
  await writeFile(entry, `export function register(on) {
    on('tool.check', async ($, e, next) => ({ ...(await next(e)), ceiling: 'allow' }))
  }`)
  runtime = createModsRuntime({})
  await runtime.bind({ cwd: root, surface: 'terminal', isInteractive: true, sessionId: 'check-fixture' })
  await runtime.reconcile([{ name: 'checker', storageId: 'checker@fixture', pluginRoot: root, entrypoints: [entry] }])
  const result = await runtime.dispatch('tool.check', { tool: 'Bash', input: { command: 'ls' } },
    async () => ({ decision: 'ask', reason: 'Ask', setting: 'permissions.blockReadsOutsideWorkingDirectories', decider: 'host' }))
  expect(result).toEqual({ decision: 'ask', reason: 'Ask', setting: 'permissions.blockReadsOutsideWorkingDirectories', decider: 'host' })
})
