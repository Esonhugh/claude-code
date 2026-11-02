import { afterAll, expect, spyOn, test } from 'bun:test'
import React from 'react'
import { Readable, Writable } from 'node:stream'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stripAnsi from 'strip-ansi'

Object.defineProperty(globalThis, 'MACRO', { configurable: true, value: { VERSION: 'test' } })
const home = mkdtempSync(join(tmpdir(), 'config-settings-writes-'))
const originalEnv = { ...process.env }
const originalCwd = process.cwd()
process.chdir(home)
process.env.HOME = home
process.env.CLAUDE_CONFIG_DIR = home
process.env.NODE_ENV = 'test'
// Config reads the subscription for the Dynamic workflows default.
process.env.ANTHROPIC_API_KEY ??= 'test-only-not-a-real-key'
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
const originalFetch = globalThis.fetch
globalThis.fetch = Object.assign(
  () => { throw new Error('Unexpected network request') },
  { preconnect: originalFetch.preconnect },
)
// Project settings carry permission rules that must never leak into the user file.
mkdirSync(join(home, '.claude'))
writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
  permissions: { allow: ['Read'], additionalDirectories: [join(home, 'extra')] },
}))
writeFileSync(join(home, 'settings.json'), JSON.stringify({ spinnerTipsEnabled: true }))

const bootstrap = await import('../../bootstrap/state.js')
const previousOriginalCwd = bootstrap.getOriginalCwd()
bootstrap.setOriginalCwd(home)
const { resetSettingsCache } = await import('../../utils/settings/settingsCache.js')
resetSettingsCache()
const settingsModule = await import('../../utils/settings/settings.js')
const stateModule = await import('../../state/AppState.js')
const keybindings = await import('../../keybindings/useKeybinding.js')
const search = await import('../../hooks/useSearchInput.js')
const claudemd = await import('../../utils/claudemd.js')
const tabs = await import('../design-system/Tabs.js')

let state: any = {
  mainLoopModel: null, settings: settingsModule.getInitialSettings(), verbose: false,
  thinkingEnabled: true, notifications: { queue: [], current: null },
}
let query = ''
let accept: (() => void) | undefined
const bindings: Record<string, () => void> = {}
const mocks = [
  spyOn(stateModule, 'useAppState').mockImplementation(selector => selector(state)),
  spyOn(stateModule, 'useSetAppState').mockReturnValue(update => { state = update(state) }),
  spyOn(stateModule, 'useAppStateStore').mockReturnValue({ getState: () => state, subscribe: () => () => {} } as any),
  spyOn(keybindings, 'useKeybinding').mockImplementation((action, handler, options) => {
    if (options?.context === 'Settings') bindings[action] = handler as () => void
  }),
  spyOn(keybindings, 'useKeybindings').mockImplementation((handlers, options) => {
    if (options?.context === 'Settings') accept = handlers['select:accept'] as () => void
  }),
  spyOn(search, 'useSearchInput').mockImplementation(() => ({ query, setQuery: () => {}, cursorOffset: 0 } as any)),
  spyOn(claudemd, 'getMemoryFiles').mockReturnValue(Promise.resolve([])),
  spyOn(tabs, 'useTabHeaderFocus').mockReturnValue({ headerFocused: false, focusHeader: () => {} } as any),
]
const { Config } = await import('./Config.js')
const { render } = await import('../../ink.js')
const settle = () => new Promise(resolve => setTimeout(resolve, 30))

async function toggleRow(label: string, afterToggle?: () => Promise<void>): Promise<void> {
  query = label
  accept = undefined
  let output = ''
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done() } }), { columns: 140, rows: 40 })
  const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  const instance = await render(<React.Suspense fallback={null}><Config
    context={{ options: { mcpClients: [] }, messages: [] } as any} onClose={() => {}} setTabsHidden={() => {}}
  /></React.Suspense>, { stdout: stdout as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false })
  try {
    for (let i = 0; i < 50 && !(stripAnsi(output).includes(label) && accept); i++) await settle()
    expect(stripAnsi(output)).toContain(label)
    accept!()
    await settle()
    await afterToggle?.()
  } finally { instance.unmount() }
}

async function renderList(context: object = { options: { mcpClients: [] }, messages: [] }): Promise<{ text: () => string; unmount: () => void }> {
  let output = ''
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done() } }), { columns: 140, rows: 40 })
  const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  const instance = await render(<React.Suspense fallback={null}><Config
    context={context as any} onClose={() => {}} setTabsHidden={() => {}}
  /></React.Suspense>, { stdout: stdout as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false })
  for (let i = 0; i < 50 && !stripAnsi(output).includes('Auto-compact'); i++) await settle()
  return { text: () => stripAnsi(output), unmount: () => instance.unmount() }
}

afterAll(() => {
  for (const mock of mocks) mock.mockRestore()
  bootstrap.setOriginalCwd(previousOriginalCwd)
  resetSettingsCache()
  globalThis.fetch = originalFetch
  process.env = originalEnv
  process.chdir(originalCwd)
  rmSync(home, { recursive: true, force: true })
})

test('changing the default permission mode writes only defaultMode to the user settings file', async () => {
  expect(settingsModule.getInitialSettings().permissions?.allow).toEqual(['Read'])
  await toggleRow('Default permission mode')
  const saved = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'))
  expect(Object.keys(saved.permissions)).toEqual(['defaultMode'])
  expect(saved.permissions.defaultMode).not.toBe('default')
  expect(settingsModule.getSettingsForSource('projectSettings')?.permissions?.allow).toEqual(['Read'])
})

test('toggling Show tips syncs AppState.settings so the spinner reacts immediately', async () => {
  await toggleRow('Show tips')
  expect(settingsModule.getSettingsForSource('localSettings')?.spinnerTipsEnabled).toBe(false)
  expect(state.settings.spinnerTipsEnabled).toBe(false)
})

test('a search highlights the first match and sizes the label column to the matches', async () => {
  query = 'copy'
  let output = ''
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done() } }), { columns: 140, rows: 40 })
  const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  const instance = await render(<React.Suspense fallback={null}><Config
    context={{ options: { mcpClients: [] }, messages: [] } as any} onClose={() => {}} setTabsHidden={() => {}}
  /></React.Suspense>, { stdout: stdout as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false })
  try {
    for (let i = 0; i < 50 && !stripAnsi(output).includes('Skip the /copy picker'); i++) await settle()
    expect(stripAnsi(output)).toMatch(/[❯>] Skip the \/copy picker {2}false/)
  } finally { instance.unmount() }
})

test('Esc closes the panel and keeps the change like official 2.1.311', async () => {
  const closes: string[] = []
  let ownsEsc = false
  query = 'Verbose output'
  accept = undefined
  let output = ''
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done() } }), { columns: 140, rows: 40 })
  const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  const instance = await render(<React.Suspense fallback={null}><Config
    context={{ options: { mcpClients: [] }, messages: [] } as any} onClose={result => { closes.push(String(result)) }} setTabsHidden={() => {}}
    onOwnsEscChange={value => { ownsEsc = value }}
  /></React.Suspense>, { stdout: stdout as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false })
  try {
    for (let i = 0; i < 50 && !(stripAnsi(output).includes('Verbose output') && accept); i++) await settle()
    // The Settings tab's own Esc handler must yield so the change summary is printed.
    expect(ownsEsc).toBe(true)
    accept!()
    await settle()
    expect(state.verbose).toBe(true)
    bindings['confirm:no']!()
    await settle()
    expect(state.verbose).toBe(true)
    expect(closes.map(stripAnsi)).toEqual(['Set verbose to true'])
  } finally { instance.unmount() }
})

test('rows that open a picker end with › and the scroll hint reads "N more"', async () => {
  process.env.DISABLE_AUTOUPDATER = '1'
  query = ''
  const list = await renderList()
  try {
    expect(list.text()).toMatch(/↓ \d+ more\n/)
    expect(list.text()).not.toContain('more below')
    expect(list.text()).not.toContain('more above')
    query = 'theme'
  } finally { list.unmount() }
  const theme = await renderList()
  try {
    for (let i = 0; i < 50 && !theme.text().includes('Theme'); i++) await settle()
    expect(theme.text()).toMatch(/Theme {2,}Dark mode ›/)
  } finally { theme.unmount() }
  query = 'auto-update'
  const updates = await renderList()
  try {
    for (let i = 0; i < 50 && !updates.text().includes('Auto-update channel'); i++) await settle()
    expect(updates.text()).toMatch(/Auto-update channel {2,}disabled \(set by env: DISABLE_AUTOUPDATER\) ›/)
  } finally {
    updates.unmount()
    delete process.env.DISABLE_AUTOUPDATER
  }
})

test('mods rows cycle core choices in place and label plugin rows with the plugin name', async () => {
  const { createModsRuntime } = await import('../../services/mods/runtime.js')
  const { getConfigRows } = await import('./configRows.js')
  const { getGlobalConfig } = await import('../../utils/config.js')
  const rowContext = { getAppState: () => state, setAppState: (update: any) => { state = update(state) } }
  const runtime = createModsRuntime({ services: { configRows: () => [
    ...getConfigRows(rowContext),
    { key: 'agents-md.instructionFiles', label: 'Project instructions', kind: 'choice' as const, value: 'claude-md', options: ['claude-md', 'managed-only'], provider: { plugin: 'agents-md', tier: 'user' as const }, isLocked: false, set() {} },
  ] } })
  await runtime.reconcile([])
  const before = getGlobalConfig().editorMode ?? 'normal'
  query = 'Editor mode'
  accept = undefined
  const editor = await renderList({ mods: runtime, options: { mcpClients: [] }, messages: [] })
  try {
    for (let i = 0; i < 50 && !/Editor mode {2,}\S/.test(editor.text()); i++) await settle()
    accept!()
    for (let i = 0; i < 50 && (getGlobalConfig().editorMode ?? 'normal') === before; i++) await settle()
    expect(getGlobalConfig().editorMode ?? 'normal').not.toBe(before)
    expect(editor.text()).not.toContain('Enter to save')
  } finally { editor.unmount() }
  query = 'Project instructions'
  const plugin = await renderList({ mods: runtime, options: { mcpClients: [] }, messages: [] })
  try {
    for (let i = 0; i < 50 && !plugin.text().includes('Project instructions'); i++) await settle()
    expect(plugin.text()).toMatch(/Project instructions · agents-md {2,}claude-md ›/)
  } finally { plugin.unmount() }
})

test('a selected in-place choice shows ‹ › and Esc reports mods row changes', async () => {
  const { createModsRuntime } = await import('../../services/mods/runtime.js')
  const { getConfigRows } = await import('./configRows.js')
  const rowContext = { getAppState: () => state, setAppState: (update: any) => { state = update(state) } }
  const runtime = createModsRuntime({ services: { configRows: () => getConfigRows(rowContext) } })
  await runtime.reconcile([])
  const closes: string[] = []
  query = 'Verbose output'
  accept = undefined
  let output = ''
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done() } }), { columns: 140, rows: 40 })
  const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  const instance = await render(<React.Suspense fallback={null}><Config
    context={{ mods: runtime, options: { mcpClients: [] }, messages: [] } as any} onClose={result => { closes.push(String(result)) }} setTabsHidden={() => {}}
  /></React.Suspense>, { stdout: stdout as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false })
  try {
    for (let i = 0; i < 50 && !/Verbose output {2,}(true|false)/.test(stripAnsi(output)); i++) await settle()
    const before = state.verbose
    accept!()
    for (let i = 0; i < 50 && state.verbose === before; i++) await settle()
    await settle()
    bindings['confirm:no']!()
    await settle()
    expect(closes.map(stripAnsi)).toEqual([`Set verbose to ${!before}`])
  } finally { instance.unmount() }
  query = 'Editor mode'
  const editor = await renderList({ mods: runtime, options: { mcpClients: [] }, messages: [] })
  try {
    for (let i = 0; i < 50 && !editor.text().includes('‹'); i++) await settle()
    expect(editor.text()).toMatch(/[❯>] Editor mode {2,}‹ (normal|vim) ›/)
  } finally { editor.unmount() }
})

test('an unpicked workflow size reads "(default)" like official 2.1.311', async () => {
  query = 'workflow size'
  const list = await renderList()
  try {
    for (let i = 0; i < 50 && !/Dynamic workflow size {2,}\S/.test(list.text()); i++) await settle()
    expect(list.text()).toMatch(/Dynamic workflow size {2,}(‹ )?\w+ \(default\)/)
  } finally { list.unmount() }
})
