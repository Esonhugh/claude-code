import { expect, spyOn, test } from 'bun:test'
import React from 'react'
import { Readable, Writable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stripAnsi from 'strip-ansi'

Object.defineProperty(globalThis, 'MACRO', { configurable: true, value: { VERSION: 'test' } })
const home = mkdtempSync(join(tmpdir(), 'config-teammate-model-'))
const originalHome = process.env.HOME
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.HOME = home
process.env.CLAUDE_CONFIG_DIR = home
process.env.NODE_ENV = 'test'
const originalFetch = globalThis.fetch
globalThis.fetch = Object.assign(
  () => { throw new Error('Unexpected network request') },
  { preconnect: originalFetch.preconnect },
)
const mocks: ReturnType<typeof spyOn>[] = []
try {
  const configModule = await import('../../utils/config.js')
  const stateModule = await import('../../state/AppState.js')
  const settingsModule = await import('../../utils/settings/settings.js')
  const keybindings = await import('../../keybindings/useKeybinding.js')
  const search = await import('../../hooks/useSearchInput.js')
  const claudemd = await import('../../utils/claudemd.js')
  const swarms = await import('../../utils/agentSwarmsEnabled.js')
  const tabs = await import('../design-system/Tabs.js')
  const modelOptions = await import('../../utils/model/modelOptions.js')
  const selectModule = await import('../CustomSelect/select.js')
  const pickerModule = await import('../ModelPicker.js')
  let config = { ...configModule.getGlobalConfig(), teammateDefaultModel: undefined as string | null | undefined }
  let writes = 0
  let accept: (() => void) | undefined
  let picker: any
  let pickerAccept: (() => void) | undefined
  const ActualSelect = selectModule.Select
  const state: any = { mainLoopModel: 'Gateway/Parent', settings: {}, verbose: false }
  const memory = Promise.resolve([])
  mocks.push(
    spyOn(configModule, 'getGlobalConfig').mockImplementation(() => config),
    spyOn(configModule, 'saveGlobalConfig').mockImplementation(update => { writes++; config = update(config) as typeof config }),
    spyOn(settingsModule, 'getInitialSettings').mockReturnValue({}),
    spyOn(settingsModule, 'getSettingsForSource').mockReturnValue({}),
    spyOn(settingsModule, 'updateSettingsForSource').mockImplementation(() => { throw new Error('Unexpected settings write') }),
    spyOn(stateModule, 'useAppState').mockImplementation(selector => selector(state)),
    spyOn(stateModule, 'useSetAppState').mockReturnValue(() => {}),
    spyOn(stateModule, 'useAppStateStore').mockReturnValue({ getState: () => state } as any),
    spyOn(keybindings, 'useKeybinding').mockImplementation(() => {}),
    spyOn(keybindings, 'useKeybindings').mockImplementation((handlers, options) => {
      if (options?.context === 'Settings') accept = handlers['select:accept'] as () => void
      else if (handlers['select:accept']) pickerAccept = handlers['select:accept'] as () => void
    }),
    spyOn(search, 'useSearchInput').mockReturnValue({ query: 'Default teammate model', setQuery: () => {}, cursorOffset: 0 } as any),
    spyOn(claudemd, 'getMemoryFiles').mockReturnValue(memory),
    spyOn(swarms, 'isAgentSwarmsEnabled').mockReturnValue(true),
    spyOn(tabs, 'useTabHeaderFocus').mockReturnValue({ headerFocused: false, focusHeader: () => {} } as any),
    spyOn(modelOptions, 'getModelOptions').mockReturnValue([{ value: null, label: 'Default', description: 'Provider default' }, { value: 'sonnet', label: 'Sonnet', description: 'Balanced' }]),
    spyOn(selectModule, 'Select').mockImplementation((props: any) => { picker = props; return <ActualSelect {...props} /> }),
    spyOn(pickerModule, 'ModelPicker').mockImplementation((props: any) => { picker = props; return null }),
  )
  const { Config } = await import('./Config.js')
  const { render } = await import('../../ink.js')
  const settle = () => new Promise(resolve => setTimeout(resolve, 30))

  test('teammate picker distinguishes automatic from inherit and unchanged values never write', async () => {
    for (const initial of [undefined, null, 'Gateway/Custom']) {
      config = { ...config, teammateDefaultModel: initial }
      writes = 0
      picker = undefined
      let output = ''
      const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done() } }), { columns: 140, rows: 40 })
      const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
      const instance = await render(<React.Suspense fallback={null}><Config
        context={{ options: { mcpClients: [] } } as any} onClose={() => {}} setTabsHidden={() => {}}
      /></React.Suspense>, { stdout: stdout as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false })
      try {
        const start = Date.now()
        while (!stripAnsi(output).includes('Default teammate model') && Date.now() - start < 1500) await settle()
        const text = stripAnsi(output)
        expect(text).toContain(initial === undefined ? 'Auto (explicit leader model, otherwise provider default)' : initial === null ? "Inherit leader's model" : initial)
        accept!()
        await settle()
        if (!picker) throw new Error(stripAnsi(output))
        const automatic = picker.options.find((option: any) => option.label.startsWith('Auto'))
        const inherit = picker.options.find((option: any) => option.label === "Inherit leader's model")
        expect(automatic).toBeDefined()
        expect(inherit).toBeDefined()
        expect(automatic.value).not.toBe(inherit.value)
        pickerAccept!()
        await settle()
        expect(writes).toBe(0)
        expect(config.teammateDefaultModel).toBe(initial)
        accept!()
        await settle()
        picker.onChange(inherit.value)
        await settle()
        expect(config.teammateDefaultModel).toBeNull()
        expect(writes).toBe(initial === null ? 0 : 1)
        accept!()
        await settle()
        picker.onChange(automatic.value)
        await settle()
        expect(config.teammateDefaultModel).toBeUndefined()
        expect('teammateDefaultModel' in config).toBe(false)
      } finally { instance.unmount() }
    }
  })
} finally {
  // Bun runs declared tests after this module is evaluated; cleanup is registered below.
  const { afterAll } = await import('bun:test')
  afterAll(() => {
    for (const mock of mocks) mock.mockRestore()
    globalThis.fetch = originalFetch
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    rmSync(home, { recursive: true, force: true })
  })
}
