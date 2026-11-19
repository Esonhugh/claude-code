import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsSchema } from './types.js'
import { generateSettingsJSONSchema } from './schemaOutput.js'
import { resetSettingsCache, setSessionSettingsCache } from './settingsCache.js'
import { getClientVersions, getSettingsWithErrors, readSettingsFile, settingsMergeCustomizer } from './settings.js'
import { getManagedFilePath, getManagedSettingsDropInDir } from './managedPath.js'
import { getOriginalCwd, setOriginalCwd } from '../../bootstrap/state.js'
import mergeWith from 'lodash-es/mergeWith.js'
import { getClaudeCodeUserAgent } from '../userAgent.js'
import { getMCPUserAgent, getUserAgent, getWebFetchUserAgent } from '../http.js'

const DEFAULTS = {
  ClaudeOAuthClientVersion: '2.1.327',
  ClaudeApiClientVersion: '2.1.327',
  CodexVersion: '0.170.0',
  ClaudeSDKVersion: '0.128.0',
}

const root = mkdtempSync(join(tmpdir(), 'version-numbers-'))
const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
const previousOriginalCwd = getOriginalCwd()
const previousManagedPath = getManagedFilePath.cache
const previousDropInPath = getManagedSettingsDropInDir.cache

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  setOriginalCwd(previousOriginalCwd)
  getManagedFilePath.cache = previousManagedPath
  getManagedSettingsDropInDir.cache = previousDropInPath
  resetSettingsCache()
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** Points user, project and managed settings at fresh temp directories. */
function useSettingsFiles(name: string, files: { user?: unknown; project?: unknown }) {
  const configDir = join(root, name, 'config')
  const projectDir = join(root, name, 'project')
  mkdirSync(join(projectDir, '.claude'), { recursive: true })
  mkdirSync(configDir, { recursive: true })
  if (files.user !== undefined) writeFileSync(join(configDir, 'settings.json'), JSON.stringify(files.user))
  if (files.project !== undefined) writeFileSync(join(projectDir, '.claude', 'settings.json'), JSON.stringify(files.project))
  process.env.CLAUDE_CONFIG_DIR = configDir
  setOriginalCwd(projectDir)
  getManagedFilePath.cache = new Map([[undefined, join(root, name, 'managed')]])
  getManagedSettingsDropInDir.cache = new Map()
  resetSettingsCache()
  return { configDir, projectDir }
}

test.each(['', ' ', '1.2\r\nInjected: yes', '1.2\n', '1.2\u0000'])('versionNumber rejects unsafe header value %j', value => {
  for (const field of ['ClaudeOAuthClientVersion', 'ClaudeApiClientVersion', 'CodexVersion', 'ClaudeSDKVersion']) {
    expect(SettingsSchema().safeParse({ versionNumber: { [field]: value } }).success).toBe(false)
  }
})

test('versionNumber supports a partial object and preserves field casing in JSON schema', () => {
  expect(SettingsSchema().parse({ versionNumber: { CodexVersion: 'custom-dev+build' } }).versionNumber).toEqual({ CodexVersion: 'custom-dev+build' })
  const schema = JSON.parse(generateSettingsJSONSchema())
  expect(Object.keys(schema.properties.versionNumber.properties)).toEqual([
    'ClaudeOAuthClientVersion', 'ClaudeApiClientVersion', 'CodexVersion', 'ClaudeSDKVersion',
  ])
  expect(schema.properties.versionNumber.required ?? []).toEqual([])
})

test.each([null, [], '2.1.327', { CodexVersion: 170 }].map(value => [value]))('versionNumber rejects invalid object/field types %j', versionNumber => {
  expect(SettingsSchema().safeParse({ versionNumber }).success).toBe(false)
})

test('default versions do not depend on the build macro', () => {
  setSessionSettingsCache({ settings: {}, errors: [] })
  expect(getClientVersions()).toEqual(DEFAULTS)
  expect(getUserAgent()).toStartWith('claude-cli/2.1.327 ')
  expect(getMCPUserAgent()).toStartWith('claude-code/2.1.327')
})

test('partial versions fall back per field and follow settings cache changes', () => {
  setSessionSettingsCache({ settings: { versionNumber: { CodexVersion: 'custom-next' } }, errors: [] })
  expect(getClientVersions()).toEqual({
    ClaudeOAuthClientVersion: '2.1.327', ClaudeApiClientVersion: '2.1.327',
    CodexVersion: 'custom-next', ClaudeSDKVersion: '0.128.0',
  })
  setSessionSettingsCache({ settings: { versionNumber: { ClaudeApiClientVersion: 'api-next' } }, errors: [] })
  expect(getClientVersions()).toEqual({
    ClaudeOAuthClientVersion: '2.1.327', ClaudeApiClientVersion: 'api-next',
    CodexVersion: '0.170.0', ClaudeSDKVersion: '0.128.0',
  })
  expect(getUserAgent()).toStartWith('claude-cli/api-next ')
  expect(getMCPUserAgent()).toStartWith('claude-code/api-next')
  expect(getClaudeCodeUserAgent(getClientVersions().ClaudeApiClientVersion)).toBe('claude-code/api-next')
  expect(getWebFetchUserAgent()).toContain('claude-code/api-next')
})

test('existing settings merge preserves partial version fields across sources', () => {
  const merged = mergeWith({},
    SettingsSchema().parse({ versionNumber: { ClaudeOAuthClientVersion: 'oauth-base', CodexVersion: 'codex-base' } }),
    SettingsSchema().parse({ versionNumber: { CodexVersion: 'codex-override', ClaudeSDKVersion: 'sdk-override' } }),
    settingsMergeCustomizer,
  )
  setSessionSettingsCache({ settings: merged, errors: [] })
  expect(getClientVersions()).toEqual({
    ClaudeOAuthClientVersion: 'oauth-base', ClaudeApiClientVersion: '2.1.327',
    CodexVersion: 'codex-override', ClaudeSDKVersion: 'sdk-override',
  })
})

test('user and project settings files merge version fields with project precedence', () => {
  useSettingsFiles('layers', {
    user: { versionNumber: { ClaudeOAuthClientVersion: 'user-oauth', CodexVersion: 'user-codex' } },
    project: { versionNumber: { CodexVersion: 'project-codex' } },
  })
  expect(getSettingsWithErrors().errors).toEqual([])
  expect(getClientVersions()).toEqual({
    ClaudeOAuthClientVersion: 'user-oauth', ClaudeApiClientVersion: '2.1.327',
    CodexVersion: 'project-codex', ClaudeSDKVersion: '0.128.0',
  })
})

test('an invalid version field is dropped with a warning and the rest of the file still applies', () => {
  const { configDir } = useSettingsFiles('invalid-field', {
    user: {
      env: { VERSION_NUMBER_TEST_ENV: 'kept' },
      versionNumber: { ClaudeApiClientVersion: '1.2 bad', CodexVersion: 'user-codex', ClaudeSDKVersion: 7 },
    },
  })
  const path = join(configDir, 'settings.json')
  const parsed = readSettingsFile(path)
  expect(parsed.settings).toMatchObject({
    env: { VERSION_NUMBER_TEST_ENV: 'kept' },
    versionNumber: { CodexVersion: 'user-codex' },
  })
  expect(parsed.settings?.versionNumber).toEqual({ CodexVersion: 'user-codex' })
  expect(parsed.errors.map(error => [error.path, error.severity])).toEqual([
    ['versionNumber.ClaudeApiClientVersion', 'warning'],
    ['versionNumber.ClaudeSDKVersion', 'warning'],
  ])
  expect(parsed.errors.every(error => error.file === path && error.message.length > 0)).toBe(true)
  // Pre-filters must not mutate the shared JSON parse cache, or a re-read loses the warnings.
  expect(readSettingsFile(path).errors.map(error => error.path)).toEqual(parsed.errors.map(error => error.path))

  const { settings, errors } = getSettingsWithErrors()
  expect(settings.env?.VERSION_NUMBER_TEST_ENV).toBe('kept')
  expect(errors.map(error => error.path)).toEqual([
    'versionNumber.ClaudeApiClientVersion', 'versionNumber.ClaudeSDKVersion',
  ])
  expect(getClientVersions()).toEqual({
    ClaudeOAuthClientVersion: '2.1.327', ClaudeApiClientVersion: '2.1.327',
    CodexVersion: 'user-codex', ClaudeSDKVersion: '0.128.0',
  })
})

test.each([null, [], '2.1.327'].map(value => [value]))('a non-object versionNumber %j is dropped without discarding the file', versionNumber => {
  const { configDir } = useSettingsFiles('invalid-object', {
    user: { env: { VERSION_NUMBER_TEST_ENV: 'kept' }, versionNumber },
  })
  const parsed = readSettingsFile(join(configDir, 'settings.json'))
  expect(parsed.settings?.env).toEqual({ VERSION_NUMBER_TEST_ENV: 'kept' })
  expect(parsed.settings && 'versionNumber' in parsed.settings).toBe(false)
  expect(parsed.errors.map(error => [error.path, error.severity])).toEqual([['versionNumber', 'warning']])
  expect(getClientVersions()).toEqual(DEFAULTS)
})
