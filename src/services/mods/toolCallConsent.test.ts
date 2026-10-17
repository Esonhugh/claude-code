import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime } from './runtime.js'
import type { ModInput } from './types.js'

let root: string
const runtimes: ReturnType<typeof createModsRuntime>[] = []
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'mods-tool-consent-')) })
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose())); await rm(root, { recursive: true, force: true }) })

test('tool.call marks consent as the person\'s only when the call descends from their own interaction', async () => {
  const seen: { consent: unknown; person: unknown }[] = []
  const runtime = createModsRuntime({ services: {
    toolHost: () => ({
      call: async (input: ModInput, _snapshot, _signal, _spawnedBy, _entry, person) => {
        seen.push({ consent: input.consent, person })
        return { result: 'ok' }
      },
      check: async () => ({ decision: 'allow' as const }),
    }),
  } })
  runtimes.push(runtime)
  await runtime.bind({ cwd: root, sessionId: 'test', surface: 'terminal', isInteractive: true })
  const pluginRoot = join(root, 'consumer')
  await mkdir(pluginRoot)
  const entry = join(pluginRoot, 'register.ts')
  await writeFile(entry, `export function register(on) {
    on('tool.call', async $ => ({ result: await $.tool.call({ tool: 'Fixture', value: 'yes', consent: 'The user pressed Yes' }) }));
    on('command.run', async $ => ({ text: JSON.stringify(await $.tool.call({ tool: 'Fixture', value: 'yes', consent: 'The user pressed Yes' })) }));
  }`)
  await runtime.reconcile([{ name: 'consumer', storageId: 'consumer@test', pluginRoot, entrypoints: [entry] }])
  await runtime.dispatch('tool.call', { tool: 'Bash', tool_use_id: 'call', command: 'x' }, async () => ({ result: 'core' }))
  await runtime.dispatch('command.run', { command: 'consumer', args: '', origin: { kind: 'composer' } }, async () => ({}))
  expect(seen).toEqual([
    { consent: 'The user pressed Yes', person: false },
    { consent: 'The user pressed Yes', person: true },
  ])
})
