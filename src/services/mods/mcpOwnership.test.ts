import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime } from './runtime.js'

let root: string
const runtimes: ReturnType<typeof createModsRuntime>[] = []
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'mods-mcp-ownership-')) })
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose())); await rm(root, { recursive: true, force: true }) })

const source = (label: string) => `export function register(on) {
  on('session.start', async ($, e, next) => { await $.mcp.connect('gmail'); return next(e) });
  on('tool.call', () => ({ result: '${label}' }));
}`
async function plugin(label: string) {
  const pluginRoot = join(root, 'consumer')
  await mkdir(pluginRoot, { recursive: true })
  const entry = join(pluginRoot, 'register.ts')
  await writeFile(entry, source(label))
  return { name: 'consumer', storageId: 'consumer@test', pluginRoot, entrypoints: [entry] }
}
function fixture() {
  const connects: string[] = []
  const releases: string[] = []
  const runtime = createModsRuntime({ services: {
    mcpConnect: async (_plugin, server) => { connects.push(server); return { isConnected: true, server } },
    mcpRelease: async source => { releases.push(source) },
  } })
  runtimes.push(runtime)
  return { runtime, connects, releases }
}

test('hot reload keeps the plugin MCP servers owned by its replacement activation', async () => {
  const { runtime, connects, releases } = fixture()
  await runtime.bind({ cwd: root, sessionId: 'test', surface: 'terminal', isInteractive: true })
  const old = await plugin('old')
  await runtime.reconcile([old])
  expect(await runtime.dispatch('tool.call', {}, async () => ({ result: 'core' }))).toEqual({ result: 'old' })
  expect(connects).toEqual(['gmail'])

  await runtime.reconcile([await plugin('new')])
  expect(await runtime.dispatch('tool.call', {}, async () => ({ result: 'core' }))).toEqual({ result: 'new' })
  expect(connects).toEqual(['gmail', 'gmail'])
  expect(releases).toEqual([])

  await runtime.reconcile([])
  expect(releases).toEqual(['consumer@test'])
})

test('worker death releases the MCP servers of every activation', async () => {
  const RealWorker = globalThis.Worker
  const natives: Worker[] = []
  globalThis.Worker = class extends RealWorker {
    constructor(url: string | URL, options?: WorkerOptions) { super(url, options); natives.push(this) }
  } as typeof Worker
  const died = Promise.withResolvers<void>()
  const releases: string[] = []
  let runtime: ReturnType<typeof createModsRuntime>
  try {
    runtime = createModsRuntime({
      onDiagnostic: event => { if (event.stage === 'worker') died.resolve() },
      services: {
        mcpConnect: async (_plugin, server) => ({ isConnected: true, server }),
        mcpRelease: async source => { releases.push(source) },
      },
    })
  } finally { globalThis.Worker = RealWorker }
  runtimes.push(runtime)
  await runtime.bind({ cwd: root, sessionId: 'test', surface: 'terminal', isInteractive: true })
  await runtime.reconcile([await plugin('old')])
  expect(releases).toEqual([])
  natives[0]!.terminate()
  await died.promise
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(releases).toEqual(['consumer@test'])
})
