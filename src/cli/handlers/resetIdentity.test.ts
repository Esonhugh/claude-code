import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const root = mkdtempSync(join(tmpdir(), 'reset-identity-test-'))
const previousConfig = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
const config = process.env.CLAUDE_CONFIG_DIR

const auth = await import('../../utils/auth.js')
const secureStorage = await import('../../utils/secureStorage/index.js')
const configModule = await import('../../utils/config.js')
const { getGlobalConfig, saveGlobalConfig } = configModule
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
  writeFileSync(join(config, 'telemetry', '1p_failed_events.s.b.json'), '{}\n{}\n')
  writeFileSync(join(config, 'telemetry', 'unrelated.json'), '{}')
  for (const profile of ['web', 'desktop']) rmSync(join(config, profile), { recursive: true, force: true })
})

// The `claude web` and desktop profiles keep their own .claude.json.
function writeProfile(profile: string, content: Record<string, unknown> | string): string {
  const file = join(config, profile, '.claude.json')
  mkdirSync(join(config, profile), { recursive: true })
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
  return file
}

function readProfile(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8'))
}

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

test('a dry run prints each value and file, and changes nothing', async () => {
  const result = await run({ dryRun: true })
  expect(result.code).toBe('exit 0')
  expect(result.out).toContain('userID = old-device')
  expect(result.out).toContain('claudeCodeFirstTokenDate = 2026-01-02T00:00:00.000Z')
  expect(result.out).toContain('1p_failed_events.s.b.json (2 event(s), 6 bytes;')
  expect(result.out).not.toContain('Log out before resetting')
  expect(getGlobalConfig().userID).toBe('old-device')
})

test('a dry run while logged in still prints the plan and says to log out', async () => {
  stored = { claudeAiOauth: { accessToken: 'fixture' } }
  const result = await run({ dryRun: true })
  expect(result.code).toBe('exit 0')
  expect(result.out).toContain('userID = old-device')
  expect(result.out).toContain('Log out before resetting: this computer still has a Claude account login')
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

test('resets the web and desktop profiles too, one write each, and keeps their other keys', async () => {
  const web = writeProfile('web', { userID: 'web-device', firstStartTime: '2026-01-03T00:00:00.000Z', theme: 'light' })
  const desktop = writeProfile('desktop', { userID: 'desktop-device', numStartups: 3 })
  const dryRun = await run({ dryRun: true })
  expect(dryRun.out).toContain(`userID = web-device (device id sent with API requests and telemetry; ${web})`)
  expect(dryRun.out).toContain('userID = desktop-device')
  expect(dryRun.out).toContain('Dry run: 7 item(s) would be reset.')

  const result = await run({ yes: true })
  expect(result.code).toBe('exit 0')
  expect(result.out).toContain('Reset 7 item(s).')
  expect(result.out).toContain('backups/')
  expect(readProfile(web)).toEqual({ theme: 'light' })
  expect(readProfile(desktop)).toEqual({ numStartups: 3 })
  expect(getGlobalConfig().userID).toBeUndefined()
})

test.each([
  ['cached account details', { oauthAccount: { accountUuid: 'a' } }],
  ['an API key saved by /login', { primaryApiKey: 'fixture' }],
] as const)('refuses while a profile has %s, and names the logout command', async (label, login) => {
  const web = writeProfile('web', { userID: 'web-device', ...login })
  const result = await run({ yes: true })
  expect(result.code).toBe('exit 1')
  expect(result.err).toContain(`${label} in ${web} (CLAUDE_CODE_SETTINGS_PROFILE=web claude auth logout)`)
  expect(readProfile(web).userID).toBe('web-device')
  expect(getGlobalConfig().userID).toBe('old-device')
})

test('a refused write exits 1 without claiming success', async () => {
  spies.push(spyOn(configModule, 'saveGlobalConfigFile').mockReturnValue(false))
  const result = await run({ yes: true })
  expect(result.code).toBe('exit 1')
  expect(result.err).toContain('Could not reset')
  expect(result.out).not.toMatch(/^Reset \d+ item/m)
})

test('an unreadable profile is left alone and fails the run', async () => {
  const web = writeProfile('web', '{ not json')
  const dryRun = await run({ dryRun: true })
  expect(dryRun.out).toContain(`Could not read ${web}`)

  const result = await run({ yes: true })
  expect(result.code).toBe('exit 1')
  expect(result.err).toContain(`Could not read ${web}`)
  expect(result.out).not.toMatch(/^Reset \d+ item/m)
  expect(readFileSync(web, 'utf8')).toBe('{ not json')
})

test('warns about credentials in the environment', async () => {
  const previous = process.env.ANTHROPIC_AUTH_TOKEN
  process.env.ANTHROPIC_AUTH_TOKEN = 'fixture'
  try {
    const result = await run({ yes: true })
    expect(result.code).toBe('exit 0')
    expect(result.err).toContain('Warning: ANTHROPIC_AUTH_TOKEN is set.')
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN
    else process.env.ANTHROPIC_AUTH_TOKEN = previous
  }
})
