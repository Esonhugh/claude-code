import { afterAll, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// No MACRO on purpose. It is written in at build time, so a process that runs
// the source has none, and the cache lookup has to work there too.
const globals = globalThis as { MACRO?: unknown }
const originalMacro = globals.MACRO
delete globals.MACRO

const ENV_NAMES = [
  'NODE_ENV',
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const
const originalEnv = ENV_NAMES.map(name => [name, process.env[name]] as const)
const tempDir = mkdtempSync(join(tmpdir(), 'claude-gateway-lookup-'))
const cacheFile = join(tempDir, 'gateway-models.json')

// A gateway base URL and nothing else: no credential of any kind.
for (const name of ENV_NAMES) delete process.env[name]
process.env.NODE_ENV = 'test'
process.env.CLAUDE_CONFIG_DIR = tempDir
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'

const { CACHE_PATHS } = await import('../cachePaths.js')
// The real path is the user's cache directory, fixed when the module loads.
const cachePath = spyOn(CACHE_PATHS, 'gatewayModels').mockReturnValue(cacheFile)
const { getGatewayModelContextWindow, getGatewayModelOptions } = await import(
  './openaiModelOptions.js'
)

afterAll(() => {
  cachePath.mockRestore()
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  if (originalMacro !== undefined) globals.MACRO = originalMacro
  rmSync(tempDir, { recursive: true, force: true })
})

test('a gateway lookup without a credential finds nothing instead of throwing', () => {
  // Under NODE_ENV=test the key lookup throws when no credential is configured.
  expect(getGatewayModelContextWindow('listed-model')).toBeUndefined()
  expect(getGatewayModelOptions()).toEqual([])
})

test('a gateway lookup that cannot build its cache key finds nothing instead of throwing', () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-placeholder'
  writeFileSync(
    cacheFile,
    JSON.stringify({
      cacheKey: 'written-for-another-gateway',
      fetchedAt: 0,
      models: [{ id: 'listed-model', max_input_tokens: 123_456 }],
    }),
  )
  // With a cache on disk the key is built, and its headers need MACRO.
  expect(getGatewayModelOptions()).toEqual([])
  expect(cachePath).toHaveBeenCalled()
})
