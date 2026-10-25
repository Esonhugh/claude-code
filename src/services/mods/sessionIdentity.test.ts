import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime, type ModHostServices } from './runtime.js'
import { modSessionIdentity } from './sessionIdentity.js'

let root: string
let runtime: ReturnType<typeof createModsRuntime> | undefined
const keys = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_OPENAI']
let saved: (string | undefined)[]
beforeEach(async () => {
  saved = keys.map(key => process.env[key])
  root = await realpath(await mkdtemp(join(tmpdir(), 'mods-identity-')))
})
afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
  keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i] })
  await rm(root, { recursive: true, force: true })
})

async function call(services: ModHostServices, hooks = '') {
  const entry = join(root, 'register.mjs')
  await writeFile(entry, `export function register(on){${hooks}
    on('tool.call',async $=>({result:await $.session.identity()}));}`)
  runtime = createModsRuntime({ services })
  await runtime.bind({ cwd: root, surface: 'terminal', isInteractive: true, sessionId: 'identity' })
  await runtime.reconcile([{ name: 'org', storageId: 'org@managed', pluginRoot: root, entrypoints: [entry] }])
  return ((await runtime.dispatch('tool.call', {}, async () => ({ result: 'missed' }))) as { result: unknown }).result
}

test('$.session.identity answers a managed mod and refuses any other with deny', async () => {
  const seen: string[] = []
  expect(await call({ sessionIdentity: storageId => { seen.push(storageId); return { kind: 'claude.ai', organizationId: 'org-1', isVerified: false } } }))
    .toEqual({ kind: 'claude.ai', organizationId: 'org-1', isVerified: false })
  expect(seen).toEqual(['org@managed'])
  await runtime?.dispose()
  runtime = undefined
  expect(await call({ sessionIdentity: () => undefined })).toEqual({
    deny: '$.session.identity answers only a mod that managed settings enable and that is loaded in place from a source they name; org is not one',
  })
})

test('session.identity hooks from the user tier never run', async () => {
  expect(await call(
    { sessionIdentity: () => ({ kind: 'api-key', isVerified: false }) },
    `on('session.identity', () => ({value:{kind:'forged',isVerified:true}}));`,
  )).toEqual({ kind: 'api-key', isVerified: false })
})

test('a cloud provider session reads as its provider with no organization', () => {
  delete process.env.CLAUDE_CODE_USE_OPENAI
  process.env.CLAUDE_CODE_USE_BEDROCK = '1'
  expect(modSessionIdentity()).toEqual({ kind: 'bedrock', isVerified: false })
})
