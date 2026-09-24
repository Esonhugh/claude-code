import { expect, spyOn, test } from 'bun:test'
import React from 'react'
import { Readable, Writable } from 'node:stream'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  let cancel: (() => void) | undefined
  let picker: any
  let pickerAccept: (() => void) | undefined
  const ActualSelect = selectModule.Select
  const state: any = { mainLoopModel: 'Gateway/Parent', settings: {}, verbose: false, notifications: { queue: [], current: null } }
  const memory = Promise.resolve([])
  mocks.push(
    spyOn(configModule, 'getGlobalConfig').mockImplementation(() => config),
    spyOn(configModule, 'saveGlobalConfig').mockImplementation(update => { writes++; config = update(config) as typeof config }),
    spyOn(settingsModule, 'getInitialSettings').mockReturnValue({}),
    spyOn(settingsModule, 'getSettingsForSource').mockReturnValue({}),
    spyOn(settingsModule, 'updateSettingsForSource').mockImplementation(() => { throw new Error('Unexpected settings write') }),
    spyOn(stateModule, 'useAppState').mockImplementation(selector => selector(state)),
    spyOn(stateModule, 'useSetAppState').mockReturnValue(() => {}),
    spyOn(stateModule, 'useAppStateStore').mockReturnValue({ getState: () => state, subscribe: () => () => {} } as any),
    spyOn(keybindings, 'useKeybinding').mockImplementation((action, handler, options) => {
      if (action === 'confirm:no' && options?.context === 'Settings') cancel = handler as () => void
    }),
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
  test('production Config consumes Worker descriptions and shows setter denials without writing', async () => {
    const {createModsRuntime} = await import('../../services/mods/runtime.js')
    const entry = join(home,'config-mod.ts')
    writeFileSync(entry, `export function register(on) {
      on('config.describe',($,e,next)=>next({...e,label:e.key==='verbose'?'Policy verbose':e.label,isHidden:e.key!=='verbose'}));
      on('config.set',()=>({deny:'Policy keeps this value'}));
    }`)
    const {getConfigRows} = await import('./configRows.js')
    const rowContext = {getAppState:()=>state,setAppState:(update:any)=>Object.assign(state,update(state))}
    const runtime = createModsRuntime({services:{configRows:() => getConfigRows(rowContext)}})
    await runtime.reconcile([{name:'config-ui',storageId:'config-ui@inline',pluginRoot:home,entrypoints:[entry]}])
    const searchMock = spyOn(search,'useSearchInput').mockReturnValue({query:'',setQuery:()=>{},cursorOffset:0} as any)
    let output = ''
    writes = 0
    const stdout = Object.assign(new Writable({write(chunk,_encoding,done){output+=chunk.toString();done()}}),{columns:140,rows:40})
    const stdin = Object.assign(new Readable({read(){}}),{isTTY:true,setRawMode(){},ref(){},unref(){}})
    const instance = await render(<React.Suspense fallback={null}><Config context={{mods:runtime,options:{mcpClients:[]},messages:[]} as any} onClose={()=>{}} setTabsHidden={()=>{}} /></React.Suspense>,{stdout:stdout as NodeJS.WriteStream,stdin:stdin as unknown as NodeJS.ReadStream,patchConsole:false,exitOnCtrlC:false})
    try {
      for(let i=0;i<50&&!stripAnsi(output).includes('Policy verbose');i++) await settle()
      expect(stripAnsi(output)).toContain('Policy verbose')
      output=''
      accept!()
      for(let i=0;i<50&&!stripAnsi(output).includes('Policy keeps this value');i++) await settle()
      expect(stripAnsi(output)).toContain('Policy keeps this value')
      expect(writes).toBe(0)
      writeFileSync(entry, `let label='Reloaded verbose'; export function register(on) {
        on('config.describe',($,e,next)=>next({...e,label:e.key==='verbose'?label:e.label,isHidden:e.key!=='verbose'}));
        on('config.set',($,e,next)=>next(e));
        on('tool.call',async $=>{label='Invalidated verbose';await $.ui.invalidate('config.describe');return {result:'ok'}});
      }`)
      output=''
      await runtime.reconcile([{name:'config-ui',storageId:'config-ui@inline',pluginRoot:home,entrypoints:[entry]}])
      for(let i=0;i<50&&!stripAnsi(output).includes('Reloaded verbose');i++) await settle()
      expect(stripAnsi(output)).toContain('Reloaded verbose')
      accept!()
      for(let i=0;i<50&&!state.verbose;i++) await settle()
      expect(state.verbose).toBe(true)
      expect(config.verbose).toBe(true)
      expect(writes).toBe(1)
      output=''
      await runtime.dispatch('tool.call',{},async()=>({result:'core'}))
      for(let i=0;i<50&&!stripAnsi(output).includes('Invalidated verbose');i++) await settle()
      expect(stripAnsi(output)).toContain('Invalidated verbose')
    } finally {
      instance.unmount()
      searchMock.mockReturnValue({query:'Default teammate model',setQuery:()=>{},cursorOffset:0} as any)
      await runtime.dispose()
    }
  })
  test('the open Mods Config menu follows live AppState changes without re-running descriptions', async () => {
    const { createModsRuntime } = await import('../../services/mods/runtime.js')
    const { getConfigRows } = await import('./configRows.js')
    const { createStore } = await import('../../state/store.js')
    const store = createStore({ ...state, mainLoopModel: 'fixture-before' })
    const storeMock = spyOn(stateModule, 'useAppStateStore').mockReturnValue(store)
    const stateMock = spyOn(stateModule, 'useAppState').mockImplementation(selector => React.useSyncExternalStore(store.subscribe, () => selector(store.getState())))
    const searchMock = spyOn(search, 'useSearchInput').mockReturnValue({ query: '', setQuery: () => {}, cursorOffset: 0 } as any)
    const entry = join(home, 'config-live-state.ts')
    writeFileSync(entry, `let calls = 0; export function register(on) {
      on('config.describe', ($, e, next) => next({ ...e, isHidden: e.key !== 'model', label: e.key === 'model' ? 'Live model ' + ++calls : e.label }));
    }`)
    const runtime = createModsRuntime({ services: { configRows: () => getConfigRows({ getAppState: store.getState, setAppState: store.setState }) } })
    await runtime.reconcile([{ name: 'config-live-state', storageId: 'config-live-state@inline', pluginRoot: home, entrypoints: [entry] }])
    let output = ''
    const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done() } }), { columns: 140, rows: 40 })
    const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
    const instance = await render(<React.Suspense fallback={null}><Config context={{ mods: runtime, options: { mcpClients: [] }, messages: [] } as any} onClose={() => {}} setTabsHidden={() => {}} /></React.Suspense>, { stdout: stdout as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false })
    try {
      for (let i = 0; i < 50 && !stripAnsi(output).includes('fixture-before'); i++) await settle()
      expect(stripAnsi(output)).toContain('fixture-before')
      output = ''
      store.setState(previous => ({ ...previous, mainLoopModel: 'fixture-after' }))
      for (let i = 0; i < 50 && !stripAnsi(output).includes('fixture-after'); i++) await settle()
      expect(stripAnsi(output)).toContain('fixture-after')
      expect(stripAnsi(output)).toContain('Live model 1')
      expect(stripAnsi(output)).not.toContain('Live model 2')
    } finally {
      instance.unmount()
      storeMock.mockReturnValue({ getState: () => state, subscribe: () => () => {} } as any)
      stateMock.mockImplementation(selector => selector(state))
      searchMock.mockReturnValue({ query: 'Default teammate model', setQuery: () => {}, cursorOffset: 0 } as any)
      await runtime.dispose()
    }
  })

  test('a stale Config row load failure cannot replace a successfully refreshed menu', async () => {
    const { createModsRuntime } = await import('../../services/mods/runtime.js')
    const stale = Promise.withResolvers<never>()
    const entered = Promise.withResolvers<void>()
    let first = true
    let failing = false
    const runtime = createModsRuntime({ services: { configRows: () => {
      if (first) { first = false; entered.resolve(); return stale.promise }
      if (failing) throw new Error('Current configuration read failed')
      return [{ key: 'fixture.current', label: 'Current configuration', kind: 'boolean', value: true, provider: { plugin: 'fixture', tier: 'user' }, isLocked: false }]
    } } })
    const searchMock = spyOn(search, 'useSearchInput').mockReturnValue({ query: '', setQuery: () => {}, cursorOffset: 0 } as any)
    let output = ''
    const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done() } }), { columns: 140, rows: 40 })
    const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
    const instance = await render(<React.Suspense fallback={null}><Config context={{ mods: runtime, options: { mcpClients: [] }, messages: [] } as any} onClose={() => {}} setTabsHidden={() => {}} /></React.Suspense>, { stdout: stdout as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false })
    try {
      await entered.promise
      runtime.config.invalidate()
      for (let i = 0; i < 50 && !stripAnsi(output).includes('Current configuration'); i++) await settle()
      expect(stripAnsi(output)).toContain('Current configuration')
      stale.reject(new Error('Retired configuration read failed'))
      await settle()
      await settle()
      expect(stripAnsi(output)).not.toContain('Retired configuration read failed')
      failing = true
      output = ''
      runtime.config.invalidate()
      for (let i = 0; i < 50 && !stripAnsi(output).includes('Current configuration read failed'); i++) await settle()
      expect(stripAnsi(output)).toContain('Current configuration read failed')
      failing = false
      output = ''
      runtime.config.invalidate()
      await settle()
      await settle()
      expect(stripAnsi(output)).toContain('Current configuration')
      expect(stripAnsi(output)).not.toContain('Current configuration read failed')
    } finally {
      stale.reject(new Error('Test completed'))
      instance.unmount()
      searchMock.mockReturnValue({ query: 'Default teammate model', setQuery: () => {}, cursorOffset: 0 } as any)
      await runtime.dispose()
    }
  })

  test('plugin choice rows open a picker and send the chosen value through Worker config.set', async () => {
    const { createModsRuntime } = await import('../../services/mods/runtime.js')
    const entry = join(home, 'config-choice.ts')
    writeFileSync(entry, `export function register(on) {
      on('config.set', ($, e, next) => {
        if (e.origin.kind !== 'composer') return { deny: 'Wrong origin' };
        return next({ ...e, value: e.value === 'b' ? 'c' : e.value });
      });
    }`)
    let selected = 'a'
    let rowWrites = 0
    const runtime = createModsRuntime({ services: { configRows: () => [{ key: 'fixture.mode', label: 'Fixture mode', kind: 'choice', value: selected, options: ['a', 'b', 'c'], provider: { plugin: 'fixture', tier: 'user' }, isLocked: false, set: value => { selected = value as string; rowWrites++ } }] } })
    await runtime.reconcile([{ name: 'config-choice', storageId: 'config-choice@inline', pluginRoot: home, entrypoints: [entry] }])
    const searchMock = spyOn(search, 'useSearchInput').mockReturnValue({ query: '', setQuery: () => {}, cursorOffset: 0 } as any)
    let output = ''
    picker = undefined
    const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done() } }), { columns: 140, rows: 40 })
    const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
    const instance = await render(<React.Suspense fallback={null}><Config context={{ mods: runtime, options: { mcpClients: [] }, messages: [] } as any} onClose={() => {}} setTabsHidden={() => {}} /></React.Suspense>, { stdout: stdout as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false })
    try {
      for (let i = 0; i < 50 && !stripAnsi(output).includes('Fixture mode'); i++) await settle()
      accept!()
      for (let i = 0; i < 50 && !picker; i++) await settle()
      expect(rowWrites).toBe(0)
      expect(picker?.options.map((option: any) => option.value)).toEqual(['a', 'b', 'c'])
      picker.onChange('b')
      for (let i = 0; i < 50 && rowWrites === 0; i++) await settle()
      expect(selected).toBe('c')
      expect(rowWrites).toBe(1)
    } finally {
      instance.unmount()
      searchMock.mockReturnValue({ query: 'Default teammate model', setQuery: () => {}, cursorOffset: 0 } as any)
      await runtime.dispose()
    }
  })

  test('Config list editor shows invalid JSON errors and permits correcting the same input', async () => {
    const { createModsRuntime } = await import('../../services/mods/runtime.js')
    const textInputModule = await import('../TextInput.js')
    const ActualTextInput = textInputModule.default
    let editor: React.ComponentProps<typeof ActualTextInput> | undefined
    const inputMock = spyOn(textInputModule, 'default').mockImplementation(props => { editor = props; return <ActualTextInput {...props} /> })
    const searchMock = spyOn(search, 'useSearchInput').mockReturnValue({ query: '', setQuery: () => {}, cursorOffset: 0 } as any)
    let labels: readonly string[] = []
    let rowWrites = 0
    const runtime = createModsRuntime({ services: { configRows: () => [{ key: 'fixture.labels', label: 'Fixture labels', kind: 'text', value: labels, provider: { plugin: 'fixture', tier: 'user' }, isLocked: false, set: value => { labels = value as readonly string[]; rowWrites++ } }] } })
    let output = ''
    const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done() } }), { columns: 140, rows: 40 })
    const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
    const instance = await render(<React.Suspense fallback={null}><Config context={{ mods: runtime, options: { mcpClients: [] }, messages: [] } as any} onClose={() => {}} setTabsHidden={() => {}} /></React.Suspense>, { stdout: stdout as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false })
    try {
      for (let i = 0; i < 50 && !stripAnsi(output).includes('Fixture labels'); i++) await settle()
      accept!()
      for (let i = 0; i < 50 && !editor; i++) await settle()
      if (!editor) throw new Error(stripAnsi(output))
      expect(editor.value).toBe('[]')
      editor!.onChange!('not a JSON list')
      await settle()
      editor!.onSubmit!('not a JSON list')
      for (let i = 0; i < 50 && !stripAnsi(output).includes('Enter a JSON list of strings'); i++) await settle()
      expect(stripAnsi(output)).toContain('Enter a JSON list of strings')
      expect(rowWrites).toBe(0)
      editor!.onChange!('["fixed"]')
      await settle()
      editor!.onSubmit!('["fixed"]')
      for (let i = 0; i < 50 && rowWrites === 0; i++) await settle()
      expect(labels).toEqual(['fixed'])
      expect(rowWrites).toBe(1)
    } finally {
      instance.unmount()
      inputMock.mockRestore()
      searchMock.mockReturnValue({ query: 'Default teammate model', setQuery: () => {}, cursorOffset: 0 } as any)
      await runtime.dispose()
    }
  })

  test('a denied model dialog change never triggers persistence when the menu is dismissed', async () => {
    const { createModsRuntime } = await import('../../services/mods/runtime.js')
    const { getConfigRows } = await import('./configRows.js')
    const entry = join(home, 'config-model-deny.ts')
    writeFileSync(entry, `export function register(on) {
      on('config.describe', ($, e, next) => next({ ...e, isHidden: e.key !== 'model' }));
      on('config.set', () => ({ deny: 'Model is pinned' }));
    }`)
    const runtime = createModsRuntime({ services: { configRows: () => getConfigRows({ getAppState: () => state, setAppState: update => Object.assign(state, update(state)) }) } })
    await runtime.reconcile([{ name: 'config-model', storageId: 'config-model@inline', pluginRoot: home, entrypoints: [entry] }])
    const searchMock = spyOn(search, 'useSearchInput').mockReturnValue({ query: '', setQuery: () => {}, cursorOffset: 0 } as any)
    let output = ''
    let closed = false
    writes = 0
    picker = undefined
    const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done() } }), { columns: 140, rows: 40 })
    const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
    const instance = await render(<React.Suspense fallback={null}><Config context={{ mods: runtime, options: { mcpClients: [] }, messages: [] } as any} onClose={() => { closed = true }} setTabsHidden={() => {}} /></React.Suspense>, { stdout: stdout as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false })
    try {
      for (let i = 0; i < 50 && !stripAnsi(output).includes('Gateway/Parent'); i++) await settle()
      expect(stripAnsi(output)).toContain('Gateway/Parent')
      accept!()
      for (let i = 0; i < 50 && !picker?.onSelect; i++) await settle()
      expect(picker?.onSelect).toBeFunction()
      picker.onSelect('sonnet')
      for (let i = 0; i < 50 && !stripAnsi(output).includes('Model is pinned'); i++) await settle()
      expect(stripAnsi(output)).toContain('Model is pinned')
      expect(writes).toBe(0)
      expect(state.mainLoopModel).toBe('Gateway/Parent')
      expect(() => cancel!()).not.toThrow()
      expect(writes).toBe(0)
      expect(closed).toBe(true)
    } finally {
      instance.unmount()
      searchMock.mockReturnValue({ query: 'Default teammate model', setQuery: () => {}, cursorOffset: 0 } as any)
      await runtime.dispose()
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
