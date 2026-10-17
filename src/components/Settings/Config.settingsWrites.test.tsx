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
const mocks = [
  spyOn(stateModule, 'useAppState').mockImplementation(selector => selector(state)),
  spyOn(stateModule, 'useSetAppState').mockReturnValue(update => { state = update(state) }),
  spyOn(stateModule, 'useAppStateStore').mockReturnValue({ getState: () => state, subscribe: () => () => {} } as any),
  spyOn(keybindings, 'useKeybinding').mockImplementation(() => {}),
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

async function toggleRow(label: string): Promise<void> {
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
  } finally { instance.unmount() }
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
