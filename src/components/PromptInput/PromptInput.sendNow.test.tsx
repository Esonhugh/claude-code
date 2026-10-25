import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import React, { useRef, useState } from 'react'
import { render, ThemeProvider } from '../../ink.js'
import { KeybindingProvider } from '../../keybindings/KeybindingContext.js'
import { DEFAULT_BINDINGS } from '../../keybindings/defaultBindings.js'
import { parseBindings } from '../../keybindings/parser.js'
import type { KeybindingContextName, ParsedKeystroke } from '../../keybindings/types.js'
import { AppStoreContext, getDefaultAppState } from '../../state/AppState.js'
import { createStore } from '../../state/store.js'
import type { PromptInputMode, VimMode } from '../../types/textInputTypes.js'
import type { PastedContent } from '../../utils/config.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import PromptInput from './PromptInput.js'

const testEnvKeys = ['HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'ANTHROPIC_API_KEY']
let testConfigRoot: string | undefined
let savedTestEnvironment: (string | undefined)[] = []
beforeEach(async () => {
  savedTestEnvironment = testEnvKeys.map(key => process.env[key])
  testConfigRoot = await realpath(await mkdtemp(join(tmpdir(), 'send-now-test-config-')))
  process.env.HOME = testConfigRoot
  process.env.CLAUDE_CONFIG_DIR = join(testConfigRoot, 'config')
  process.env.XDG_CONFIG_HOME = join(testConfigRoot, 'xdg-config')
  process.env.XDG_CACHE_HOME = join(testConfigRoot, 'xdg-cache')
  process.env.XDG_STATE_HOME = join(testConfigRoot, 'xdg-state')
  process.env.ANTHROPIC_API_KEY = 'sk-test-placeholder'
  resetSettingsCache()
})
afterEach(async () => {
  resetSettingsCache()
  testEnvKeys.forEach((key, i) => {
    if (savedTestEnvironment[i] === undefined) delete process.env[key]
    else process.env[key] = savedTestEnvironment[i]
  })
  if (testConfigRoot !== undefined) {
    await rm(testConfigRoot, { recursive: true, force: true })
    testConfigRoot = undefined
  }
})

class Input extends Readable {
  isTTY = true
  _read() {}
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
class Output extends Writable {
  columns = 80
  rows = 24
  isTTY = true
  _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void) { done() }
}

function Keybindings({ children }: { children: React.ReactNode }) {
  const pending = useRef<ParsedKeystroke[] | null>(null)
  const registry = useRef(new Map())
  const contexts = useRef(new Set<KeybindingContextName>(['Global', 'Chat']))
  return (
    <KeybindingProvider
      bindings={parseBindings(DEFAULT_BINDINGS)}
      pendingChordRef={pending}
      pendingChord={null}
      setPendingChord={value => { pending.current = value }}
      activeContexts={contexts.current}
      registerActiveContext={value => { contexts.current.add(value) }}
      unregisterActiveContext={value => { contexts.current.delete(value) }}
      handlerRegistryRef={registry}
    >
      {children}
    </KeybindingProvider>
  )
}

type SubmitCall = { input: string; options: unknown }

async function mount(initial: string) {
  const previousEditorMode = getGlobalConfig().editorMode
  saveGlobalConfig(config => ({ ...config, editorMode: 'normal' }))
  const stdin = new Input()
  const stdout = new Output()
  const initialState = getDefaultAppState()
  const submits: SubmitCall[] = []
  let value = initial
  function Probe() {
    const [input, setInput] = useState(initial)
    const [mode, setMode] = useState<PromptInputMode>('prompt')
    const [pastedContents, setPastedContents] = useState<Record<number, PastedContent>>({})
    const [vimMode, setVimMode] = useState<VimMode>('INSERT')
    const [helpOpen, setHelpOpen] = useState(false)
    const [searching, setSearching] = useState(false)
    value = input
    return (
      <PromptInput debug={false} ideSelection={undefined}
        toolPermissionContext={initialState.toolPermissionContext} setToolPermissionContext={() => {}}
        apiKeyStatus="valid" commands={[]} agents={[]} enableLocalIOCompletions={false}
        isLoading={true} isAssistantResponding={true} verbose={false} messages={[]}
        onAutoUpdaterResult={() => {}} autoUpdaterResult={null} input={input}
        onInputChange={next => { value = next; setInput(next) }}
        mode={mode} onModeChange={setMode} stashedPrompt={undefined} setStashedPrompt={() => {}}
        submitCount={0} onShowMessageSelector={() => {}} mcpClients={[]}
        pastedContents={pastedContents} setPastedContents={setPastedContents} vimMode={vimMode} setVimMode={setVimMode}
        showBashesDialog={false} setShowBashesDialog={() => {}} onExit={() => {}}
        getToolUseContext={() => { throw new Error('This input fixture does not execute a query') }}
        onSubmit={async (submitted, _helpers, _speculation, options) => { submits.push({ input: submitted, options }) }}
        isSearchingHistory={searching} setIsSearchingHistory={setSearching} helpOpen={helpOpen} setHelpOpen={setHelpOpen} />
    )
  }
  const instance = await render(
    <AppStoreContext value={createStore(initialState)}>
      <ThemeProvider initialState="dark"><Keybindings><Probe /></Keybindings></ThemeProvider>
    </AppStoreContext>,
    { stdin: stdin as never, stdout: stdout as never, patchConsole: false, exitOnCtrlC: false },
  )
  async function settle() {
    for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve))
  }
  await settle()
  return {
    submits,
    get value() { return value },
    async send(chunk: string) { stdin.push(chunk); await settle() },
    dispose() {
      instance.unmount()
      instance.cleanup()
      saveGlobalConfig(config => ({ ...config, editorMode: previousEditorMode }))
    },
  }
}

test('ctrl+enter submits the draft with sendNow instead of plain queueing', async () => {
  const h = await mount('ship it')
  try {
    await h.send('\x1b[13;5u')
    expect(h.submits).toEqual([{ input: 'ship it', options: { sendNow: true } }])
  } finally {
    h.dispose()
  }
})

test('ctrl+x ctrl+s is the portable send-now chord', async () => {
  const h = await mount('ship it')
  try {
    await h.send('\x18')
    await h.send('\x13')
    expect(h.submits).toEqual([{ input: 'ship it', options: { sendNow: true } }])
  } finally {
    h.dispose()
  }
})

test('send-now with an empty prompt still reaches the REPL to flush the queue', async () => {
  const h = await mount('')
  try {
    await h.send('\x1b[13;5u')
    expect(h.submits).toEqual([{ input: '', options: { sendNow: true } }])
  } finally {
    h.dispose()
  }
})

test('plain enter keeps the normal submit path', async () => {
  const h = await mount('ship it')
  try {
    await h.send('\r')
    expect(h.submits).toEqual([{ input: 'ship it', options: undefined }])
  } finally {
    h.dispose()
  }
})

test('ctrl+j inserts a newline from both kitty and legacy terminals', async () => {
  const h = await mount('ab')
  try {
    await h.send('\x1b[106;5u')
    expect(h.value).toBe('ab\n')
    await h.send('\n')
    expect(h.value).toBe('ab\n\n')
    expect(h.submits).toEqual([])
  } finally {
    h.dispose()
  }
})
