import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const root = mkdtempSync(join(tmpdir(), 'reset-identity-test-'))
const previousConfig = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
const config = process.env.CLAUDE_CONFIG_DIR

const auth = await import('../../utils/auth.js')
const secureStorage = await import('../../utils/secureStorage/index.js')
const { getGlobalConfig, saveGlobalConfig } = await import('../../utils/config.js')
const { resetIdentityHandler } = await import('./resetIdentity.js')

// Never read the real keychain: each test says what is stored.
let stored: Record<string, unknown> | null = null
let savedApiKey: { key: string; source: '/login managed key' } | null = null
const spies: { mockRestore(): void }[] = []

beforeEach(() => {
  stored = null
  savedApiKey = null
  spies.push(
    spyOn(secureStorage, 'getSecureStorage').mockReturnValue({ read: () => stored } as never),
    spyOn(auth, 'getApiKeyFromConfigOrMacOSKeychain').mockImplementation((() => savedApiKey) as never),
  )
  saveGlobalConfig(current => ({
    ...current,
    userID: 'old-device',
    firstStartTime: '2026-01-01T00:00:00.000Z',
    claudeCodeFirstTokenDate: '2026-01-02T00:00:00.000Z',
    oauthAccount: undefined,
    theme: 'dark',
  }))
  mkdirSync(join(config, 'telemetry'), { recursive: true })
  writeFileSync(join(config, 'telemetry', '1p_failed_events.s.b.json'), '[]')
  writeFileSync(join(config, 'telemetry', 'unrelated.json'), '{}')
})

afterEach(() => {
  spies.splice(0).forEach(spy => spy.mockRestore())
})

afterAll(() => {
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  rmSync(root, { recursive: true, force: true })
})

async function run(options: Parameters<typeof resetIdentityHandler>[0]) {
  const out: string[] = []
  const err: string[] = []
  const stdout = spyOn(process.stdout, 'write').mockImplementation(chunk => (out.push(String(chunk)), true))
  const stderr = spyOn(process.stderr, 'write').mockImplementation(chunk => (err.push(String(chunk)), true))
  const exit = spyOn(process, 'exit').mockImplementation(code => {
    throw new Error(`exit ${code}`)
  })
  let code = 'returned'
  try {
    await resetIdentityHandler(options)
  } catch (error) {
    code = (error as Error).message
  } finally {
    stdout.mockRestore()
    stderr.mockRestore()
    exit.mockRestore()
  }
  return { code, out: out.join(''), err: err.join('') }
}

test('resets the device id, dates and queued telemetry, and keeps everything else', async () => {
  const result = await run({ yes: true })
  expect(result.code).toBe('exit 0')
  const after = getGlobalConfig()
  expect(after.userID).toBeUndefined()
  expect(after.firstStartTime).toBeUndefined()
  expect(after.claudeCodeFirstTokenDate).toBeUndefined()
  expect(after.theme).toBe('dark')
  expect(existsSync(join(config, 'telemetry', '1p_failed_events.s.b.json'))).toBe(false)
  expect(existsSync(join(config, 'telemetry', 'unrelated.json'))).toBe(true)
})

test('a dry run lists the items and changes nothing', async () => {
  const result = await run({ dryRun: true })
  expect(result.code).toBe('exit 0')
  expect(result.out).toContain('userID')
  expect(result.out).toContain('1p_failed_events.s.b.json')
  expect(getGlobalConfig().userID).toBe('old-device')
})

test.each([
  ['a Claude login', () => { stored = { claudeAiOauth: { accessToken: 'fixture' } } }],
  ['cached account details', () => saveGlobalConfig(c => ({ ...c, oauthAccount: { accountUuid: 'a' } as never }))],
  ['an API key saved by /login', () => { savedApiKey = { key: 'fixture', source: '/login managed key' } }],
] as const)('refuses while logged in with %s', async (_label, seed) => {
  seed()
  const result = await run({ yes: true })
  expect(result.code).toBe('exit 1')
  expect(result.err).toContain('Log out first')
  expect(getGlobalConfig().userID).toBe('old-device')
})

test('running again finds nothing to reset', async () => {
  await run({ yes: true })
  const result = await run({ yes: true })
  expect(result.code).toBe('exit 0')
  expect(result.out).toContain('Nothing to reset')
})
