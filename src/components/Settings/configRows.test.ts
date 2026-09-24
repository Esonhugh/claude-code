import { afterAll, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppState } from '../../state/AppStateStore.js'

const home = mkdtempSync(join(tmpdir(), 'config-rows-'))
const originalEnv = { ...process.env }
const originalCwd = process.cwd()
process.chdir(home)
process.env.HOME = home
process.env.CLAUDE_CONFIG_DIR = home
process.env.NODE_ENV = 'test'
delete process.env.ANTHROPIC_API_KEY
process.env.CLAUDE_CODE_DISABLE_FAST_MODE = '1'
process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '0'
process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = '0'
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
const originalMacro = Object.getOwnPropertyDescriptor(globalThis, 'MACRO')
Object.defineProperty(globalThis, 'MACRO', { configurable: true, value: { VERSION: 'test' } })
const originalFetch = globalThis.fetch
globalThis.fetch = Object.assign(
  () => { throw new Error('Unexpected network request') },
  { preconnect: originalFetch.preconnect },
)

const managedPath = await import('../../utils/settings/managedPath.js')
const previousManagedPath = managedPath.getManagedFilePath.cache
const previousDropInPath = managedPath.getManagedSettingsDropInDir.cache
managedPath.getManagedFilePath.cache = new Map([[undefined, home]])
managedPath.getManagedSettingsDropInDir.cache = new Map()
const bootstrap = await import('../../bootstrap/state.js')
const previousOriginalCwd = bootstrap.getOriginalCwd()
bootstrap.setOriginalCwd(home)
const { resetSettingsCache } = await import('../../utils/settings/settingsCache.js')
resetSettingsCache()

afterAll(() => {
  bootstrap.setOriginalCwd(previousOriginalCwd)
  resetSettingsCache()
  managedPath.getManagedFilePath.cache = previousManagedPath
  managedPath.getManagedSettingsDropInDir.cache = previousDropInPath
  globalThis.fetch = originalFetch
  if (originalMacro) Object.defineProperty(globalThis, 'MACRO', originalMacro)
  else Reflect.deleteProperty(globalThis, 'MACRO')
  process.env = originalEnv
  process.chdir(originalCwd)
  rmSync(home, { recursive: true, force: true })
})

test('exposes real built-in config rows in menu order, including dialog-only rows', async () => {
  const { getConfigRows } = await import('./configRows.js')
  let state = { settings: {}, verbose: false, thinkingEnabled: true, mainLoopModel: null } as AppState
  const rows = getConfigRows({
    getAppState: () => state,
    setAppState: update => { state = update(state) },
  })
  const keys = [
    'autoCompact', 'tips', 'prefersReducedMotion',
    'thinkingEnabled', 'fileCheckpointingEnabled', 'verbose',
    'terminalProgressBarEnabled', 'showTurnDuration', 'defaultPermissionMode',
    'respectGitignore', 'copyFullResponse', 'autoUpdatesChannel', 'theme',
    'notifChannel', 'outputStyle', 'language', 'editorMode', 'prStatusFooterEnabled',
    'model', 'claudeInChromeDefaultEnabled',
  ]
  expect(rows.filter(row => keys.includes(row.key)).map(row => row.key)).toEqual(keys)
  expect(new Set(rows.map(row => row.key)).size).toBe(rows.length)
  expect(rows.find(row => row.key === 'autoCompact')).toMatchObject({
    label: 'Auto-compact', kind: 'boolean', value: true,
    provider: { plugin: 'engine', tier: 'core' }, isLocked: false,
  })
  for (const key of ['autoUpdatesChannel', 'outputStyle', 'language', 'model']) {
    expect(rows.find(row => row.key === key)?.set).toBeUndefined()
  }
}, 30_000)

test('policySettings supplies the effective value and locks aliases at the write boundary', async () => {
  const { getConfigRows } = await import('./configRows.js')
  const settings = await import('../../utils/settings/settings.js')
  const policyFile = join(home, 'managed-settings.json')
  let state = { settings: {}, verbose: false, thinkingEnabled: true, mainLoopModel: null } as AppState
  const context = { getAppState: () => state, setAppState: (update: (state: AppState) => AppState) => { state = update(state) } }
  try {
    const stale = getConfigRows(context).find(row => row.key === 'thinkingEnabled')!
    writeFileSync(policyFile, JSON.stringify({ alwaysThinkingEnabled: false, permissions: { defaultMode: 'acceptEdits' }, spinnerTipsEnabled: false }))
    resetSettingsCache()
    expect(settings.getSettingsForSource('policySettings')?.alwaysThinkingEnabled).toBe(false)
    expect(getConfigRows(context).find(row => row.key === 'thinkingEnabled')).toMatchObject({ value: false, isLocked: true })
    expect(getConfigRows(context).find(row => row.key === 'defaultPermissionMode')).toMatchObject({ value: 'acceptEdits', isLocked: true })
    expect(() => stale.set!(false)).toThrow('locked by policySettings')
    expect(getConfigRows(context).find(row => row.key === 'tips')?.isLocked).toBe(true)
    expect(getConfigRows(context).find(row => row.key === 'verbose')?.isLocked).toBe(false)
  } finally {
    rmSync(policyFile, { force: true })
    resetSettingsCache()
  }
})

test('writers persist settings in the correct source, preserve siblings and update AppState immediately', async () => {
  const { getConfigRows } = await import('./configRows.js')
  const settings = await import('../../utils/settings/settings.js')
  const config = await import('../../utils/config.js')
  settings.updateSettingsForSource('userSettings', { permissions: { allow: ['Read'] } })
  let state = { settings: settings.getInitialSettings(), verbose: false, thinkingEnabled: true, mainLoopModel: null } as unknown as AppState
  const context = { getAppState: () => state, setAppState: (update: (state: AppState) => AppState) => { state = update(state) } }
  const row = (key: string) => getConfigRows(context).find(row => row.key === key)!
  await row('verbose').set!(true)
  expect(config.getGlobalConfig().verbose).toBe(true)
  expect(state.verbose).toBe(true)
  await row('tips').set!(false)
  await row('prefersReducedMotion').set!(true)
  expect(settings.getSettingsForSource('localSettings')).toMatchObject({ spinnerTipsEnabled: false, prefersReducedMotion: true })
  expect(state.settings).toMatchObject({ spinnerTipsEnabled: false, prefersReducedMotion: true })
  expect(settings.getSettingsForSource('userSettings')?.spinnerTipsEnabled).toBeUndefined()
  await row('thinkingEnabled').set!(false)
  expect(settings.getSettingsForSource('userSettings')?.alwaysThinkingEnabled).toBe(false)
  expect(state.thinkingEnabled).toBe(false)
  await row('thinkingEnabled').set!(true)
  expect(settings.getSettingsForSource('userSettings')?.alwaysThinkingEnabled).toBeUndefined()
  expect(state.thinkingEnabled).toBe(true)
  await row('defaultPermissionMode').set!('acceptEdits')
  expect(settings.getSettingsForSource('userSettings')?.permissions).toEqual({ allow: ['Read'], defaultMode: 'acceptEdits' })
  expect(state.settings.permissions?.defaultMode).toBe('acceptEdits')
  expect(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).permissions.defaultMode).toBe('acceptEdits')
  expect(JSON.parse(readFileSync(join(home, '.claude/settings.local.json'), 'utf8')).prefersReducedMotion).toBe(true)
})

test('all six concrete themes persist and notify the UI, while invalid choices cannot write', async () => {
  const { getConfigRows } = await import('./configRows.js')
  const config = await import('../../utils/config.js')
  const { getGlobalClaudeFile } = await import('../../utils/env.js')
  process.env.NODE_ENV = 'production'
  config.enableConfigs()
  expect(getGlobalClaudeFile()).toBe(join(home, '.claude.json'))
  let selected = ''
  const context = {
    getAppState: () => ({ settings: {}, verbose: false, thinkingEnabled: true, mainLoopModel: null } as AppState),
    setAppState: () => {},
    options: { setTheme: (theme: string) => { selected = theme } },
  }
  const theme = getConfigRows(context).find(row => row.key === 'theme')!
  expect(theme.options).toEqual(['dark', 'light', 'light-daltonized', 'dark-daltonized', 'light-ansi', 'dark-ansi'])
  for (const value of theme.options!) {
    await theme.set!(value)
    expect<string>(config.getGlobalConfig().theme).toBe(value)
    expect(getConfigRows(context).find(row => row.key === 'theme')?.value).toBe(value)
    expect(selected).toBe(value)
    expect(JSON.parse(readFileSync(getGlobalClaudeFile(), 'utf8')).theme ?? 'dark').toBe(value)
  }
  expect(() => theme.set!('invalid')).toThrow('Invalid value')
  expect(() => theme.set!(false)).toThrow('Invalid value')
  expect(config.getGlobalConfig().theme).toBe('dark-ansi')
  const permission = getConfigRows(context).find(row => row.key === 'defaultPermissionMode')!
  expect(permission.options).not.toContain('bypassPermissions')
  expect(() => permission.set!('bypassPermissions')).toThrow('Invalid value')
})

test('conditional rows retain menu order, use live state, and leave dialogs read-only', async () => {
  const { getConfigRows } = await import('./configRows.js')
  const swarms = await import('../../utils/agentSwarmsEnabled.js')
  const ide = await import('../../utils/ide.js')
  const fullscreen = await import('../../utils/fullscreen.js')
  const fastMode = await import('../../utils/fastMode.js')
  const provider = await import('../../utils/model/providers.js')
  const gates = await import('../../services/analytics/growthbook.js')
  const teammate = await import('../../utils/swarm/backends/teammateModeSnapshot.js')
  const config = await import('../../utils/config.js')
  const gate = gates.getFeatureValue_CACHED_MAY_BE_STALE
  const mocks = [
    spyOn(swarms, 'isAgentSwarmsEnabled').mockReturnValue(true),
    spyOn(ide, 'isSupportedTerminal').mockReturnValue(false),
    spyOn(fullscreen, 'isFullscreenEnvEnabled').mockReturnValue(true),
    spyOn(fastMode, 'isFastModeEnabled').mockReturnValue(true),
    spyOn(fastMode, 'isFastModeAvailable').mockReturnValue(true),
    spyOn(fastMode, 'isFastModeSupportedByModel').mockReturnValue(true),
    spyOn(provider, 'getAPIProvider').mockReturnValue('openai'),
    spyOn(gates, 'getFeatureValue_CACHED_MAY_BE_STALE').mockImplementation((key, fallback) =>
      ['tengu_chomp_inflection', 'tengu_terminal_sidebar'].includes(key) ? true as any : gate(key, fallback)),
  ]
  let state = { settings: {}, verbose: false, thinkingEnabled: true, mainLoopModel: 'custom-model', promptSuggestionEnabled: true, fastMode: false } as AppState
  const context: Parameters<typeof getConfigRows>[0] = {
    getAppState: () => state, setAppState: update => { state = update(state) },
    options: { mcpClients: [{ type: 'connected', name: 'ide' } as any], hasExternalIncludes: true, customApiKeySuffix: 'fixture-suffix' },
  }
  try {
    const rows = getConfigRows(context)
    const keys = rows.map(row => row.key)
    const conditionalKeys = ['fastMode', 'promptSuggestionEnabled', 'showStatusInTerminalTab', 'copyOnSelect', 'diffTool', 'autoConnectIde', 'teammateMode', 'teammateDefaultModel', 'showExternalIncludesDialog', 'apiKey']
    expect(keys.filter(key => conditionalKeys.includes(key))).toEqual(conditionalKeys)
    expect(rows.find(row => row.key === 'model')?.value).toBe('custom-model')
    for (const key of ['teammateDefaultModel', 'showExternalIncludesDialog']) expect(rows.find(row => row.key === key)?.set).toBeUndefined()
    await rows.find(row => row.key === 'fastMode')!.set!(true)
    expect(state.fastMode).toBe(true)
    expect(state.mainLoopModel).toBe('custom-model')
    await rows.find(row => row.key === 'promptSuggestionEnabled')!.set!(false)
    expect(state.promptSuggestionEnabled).toBe(false)
    expect(state.settings.promptSuggestionEnabled).toBe(false)
    teammate.setCliTeammateModeOverride('tmux')
    expect(getConfigRows(context).find(row => row.key === 'teammateMode')?.label).toContain('overridden: tmux')
    await rows.find(row => row.key === 'teammateMode')!.set!('in-process')
    expect(teammate.getCliTeammateModeOverride()).toBeNull()
    expect(teammate.getTeammateModeFromSnapshot()).toBe('in-process')
    expect(config.getGlobalConfig().teammateMode).toBe('in-process')
    const apiKey = rows.find(row => row.key === 'apiKey')!
    await apiKey.set!(true)
    await apiKey.set!(true)
    expect(config.getGlobalConfig().customApiKeyResponses.approved).toEqual(['fixture-suffix'])
    await apiKey.set!(false)
    expect(config.getGlobalConfig().customApiKeyResponses.approved).toEqual([])
    expect(config.getGlobalConfig().customApiKeyResponses.rejected).toEqual(['fixture-suffix'])
  } finally { for (const mock of mocks) mock.mockRestore() }
})

test('production rows include the custom-key setting without host-specific options and omit it on Homespace', async () => {
  const { getConfigRows } = await import('./configRows.js')
  const config = await import('../../utils/config.js')
  const environment = await import('../../utils/envUtils.js')
  const previousKey = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'fixture-not-a-credential-config-key'
  const homespace = spyOn(environment, 'isRunningOnHomespace').mockReturnValue(false)
  const context = {
    getAppState: () => ({ settings: {}, verbose: false, thinkingEnabled: true, mainLoopModel: null } as AppState),
    setAppState: () => {},
  }
  try {
    const row = getConfigRows(context).find(row => row.key === 'apiKey')
    expect(row).toMatchObject({ label: 'Use custom API key', kind: 'boolean', value: false })
    await row!.set!(true)
    expect(getConfigRows(context).find(row => row.key === 'apiKey')?.value).toBe(true)
    expect(config.getGlobalConfig().customApiKeyResponses.approved).toContain('redential-config-key')
    expect(JSON.stringify(getConfigRows(context))).not.toContain(process.env.ANTHROPIC_API_KEY)
    homespace.mockReturnValue(true)
    expect(getConfigRows(context).find(row => row.key === 'apiKey')).toBeUndefined()
    homespace.mockReturnValue(false)
    delete process.env.ANTHROPIC_API_KEY
    expect(getConfigRows(context).find(row => row.key === 'apiKey')).toBeUndefined()
  } finally {
    homespace.mockRestore()
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previousKey
  }
}, 30_000)

test('global boolean and choice writers preserve unrelated config on disk', async () => {
  const { getConfigRows } = await import('./configRows.js')
  const config = await import('../../utils/config.js')
  const { getGlobalClaudeFile } = await import('../../utils/env.js')
  const context = {
    getAppState: () => ({ settings: {}, verbose: false, thinkingEnabled: true, mainLoopModel: null } as AppState),
    setAppState: () => {},
  }
  config.saveGlobalConfig(current => ({ ...current, editorMode: 'emacs', theme: 'light-ansi' }))
  expect(getConfigRows(context).find(row => row.key === 'editorMode')?.value).toBe('normal')
  for (const key of ['autoCompact', 'fileCheckpointingEnabled', 'terminalProgressBarEnabled', 'showTurnDuration', 'respectGitignore', 'copyFullResponse', 'prStatusFooterEnabled', 'claudeInChromeDefaultEnabled']) {
    const row = getConfigRows(context).find(row => row.key === key)!
    const value = !row.value
    await row.set!(value)
    expect(getConfigRows(context).find(row => row.key === key)?.value).toBe(value)
    expect(JSON.parse(readFileSync(getGlobalClaudeFile(), 'utf8'))[key === 'autoCompact' ? 'autoCompactEnabled' : key]).toBe(value)
  }
  await getConfigRows(context).find(row => row.key === 'editorMode')!.set!('vim')
  await getConfigRows(context).find(row => row.key === 'notifChannel')!.set!('notifications_disabled')
  expect(JSON.parse(readFileSync(getGlobalClaudeFile(), 'utf8'))).toMatchObject({ editorMode: 'vim', preferredNotifChannel: 'notifications_disabled', theme: 'light-ansi' })
})

test('/config without Mods uses production writers and rejects unknown, invalid and dialog-only writes', async () => {
  const { call } = await import('../../commands/config/config.js')
  const config = await import('../../utils/config.js')
  const { getGlobalClaudeFile } = await import('../../utils/env.js')
  let state = { settings: {}, verbose: true, thinkingEnabled: true, mainLoopModel: null } as AppState
  const context = {
    getAppState: () => state,
    setAppState: (update: (state: AppState) => AppState) => { state = update(state) },
    options: { mcpClients: [] },
  } as Parameters<typeof call>[1]
  const replies: (string | undefined)[] = []
  const done: Parameters<typeof call>[0] = text => { replies.push(text) }
  expect(await call(done, context, 'verbose=false')).toBeNull()
  expect(replies.at(-1)).toBe('verbose = false')
  expect(config.getGlobalConfig().verbose).toBe(false)
  expect(state.verbose).toBe(false)
  const saved = readFileSync(getGlobalClaudeFile(), 'utf8')
  expect(await call(done, context, 'verbose="true"')).toBeNull()
  expect(replies.at(-1)).toContain('Invalid value')
  expect(await call(done, context, 'model=sonnet')).toBeNull()
  expect(replies.at(-1)).toContain('only be changed in its dialog')
  expect(await call(done, context, 'unknown=true')).toBeNull()
  expect(replies.at(-1)).toContain('Unknown config key')
  expect(await call(done, context, 'verbose')).toBeNull()
  expect(replies.at(-1)).toBe('Usage: /config key=value')
  expect(readFileSync(getGlobalClaudeFile(), 'utf8')).toBe(saved)
  expect(state.mainLoopModel).toBeNull()
})

test('official autoCompact and tips keys address the existing production settings', async () => {
  const { call } = await import('../../commands/config/config.js')
  const config = await import('../../utils/config.js')
  const settings = await import('../../utils/settings/settings.js')
  const { getConfigRows } = await import('./configRows.js')
  let state = { settings: {}, verbose: false, thinkingEnabled: true, mainLoopModel: null } as AppState
  const context = {
    getAppState: () => state,
    setAppState: (update: (state: AppState) => AppState) => { state = update(state) },
    options: { mcpClients: [] },
  } as Parameters<typeof call>[1]
  const replies: (string | undefined)[] = []
  await call(text => { replies.push(text) }, context, 'autoCompact=false')
  expect(replies.at(-1)).toBe('autoCompact = false')
  expect(config.getGlobalConfig().autoCompactEnabled).toBe(false)
  await call(text => { replies.push(text) }, context, 'tips=false')
  expect(replies.at(-1)).toBe('tips = false')
  expect(settings.getSettingsForSource('localSettings')?.spinnerTipsEnabled).toBe(false)
  expect(getConfigRows(context).filter(row => ['autoCompact', 'tips'].includes(row.key)).map(row => row.value)).toEqual([false, false])
})

test('Worker config calls consume the official row catalog and persist through production writers', async () => {
  const { createModsRuntime } = await import('../../services/mods/runtime.js')
  const { getConfigRows } = await import('./configRows.js')
  const { getGlobalConfig } = await import('../../utils/config.js')
  const { getSettingsForSource } = await import('../../utils/settings/settings.js')
  const { getGlobalClaudeFile } = await import('../../utils/env.js')
  const entry = join(home, 'official-config-rows.ts')
  writeFileSync(entry, `export function register(on) {
    on('config.describe', { key: 'tips' }, ($, e, next) => next({ ...e, label: 'Official tips' }));
    on('tool.call', async $ => ({ result: {
      listed: (await $.config.list()).filter(row => row.key === 'autoCompact' || row.key === 'tips'),
      compact: await $.config.set({ key: 'autoCompact', value: true }),
      tips: await $.config.set({ key: 'tips', value: true }),
    } }));
  }`)
  let state = { settings: {}, verbose: false, thinkingEnabled: true, mainLoopModel: null } as AppState
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({ onDiagnostic: event => diagnostics.push(event), services: { configRows: () => getConfigRows({
    getAppState: () => state,
    setAppState: update => { state = update(state) },
  }) } })
  try {
    await runtime.reconcile([{ name: 'official-config-rows', storageId: 'official-config-rows@inline', pluginRoot: home, entrypoints: [entry] }])
    const result = await runtime.dispatch('tool.call', {}, async () => ({ result: 'core' }))
    expect(result).toEqual({ result: {
      listed: [
        {
          key: 'autoCompact', label: 'Auto-compact', kind: 'boolean', value: false,
          provider: { plugin: 'engine', tier: 'core' }, isLocked: false,
        },
        {
          key: 'tips', label: 'Official tips', kind: 'boolean', value: false,
          provider: { plugin: 'engine', tier: 'core' }, isLocked: false,
        },
      ],
      compact: { value: true }, tips: { value: true },
    } })
    expect(getGlobalConfig().autoCompactEnabled).toBe(true)
    expect(JSON.parse(readFileSync(getGlobalClaudeFile(), 'utf8')).autoCompactEnabled ?? true).toBe(true)
    expect(getSettingsForSource('localSettings')?.spinnerTipsEnabled).toBe(true)
    expect(JSON.parse(readFileSync(join(home, '.claude/settings.local.json'), 'utf8')).spinnerTipsEnabled).toBe(true)
    expect(state.settings.spinnerTipsEnabled).toBe(true)
    expect(diagnostics).toEqual([])
  } finally { await runtime.dispose() }
})

test('settings write errors propagate without changing AppState', async () => {
  const { getConfigRows } = await import('./configRows.js')
  const settings = await import('../../utils/settings/settings.js')
  let state = { settings: {}, thinkingEnabled: true, verbose: false, mainLoopModel: null } as AppState
  const initial = state
  const row = getConfigRows({ getAppState: () => state, setAppState: update => { state = update(state) } }).find(row => row.key === 'thinkingEnabled')!
  const failure = spyOn(settings, 'updateSettingsForSource').mockReturnValue({ error: new Error('disk full') })
  try {
    expect(() => row.set!(false)).toThrow('disk full')
    expect(state).toBe(initial)
  } finally { failure.mockRestore() }
})
