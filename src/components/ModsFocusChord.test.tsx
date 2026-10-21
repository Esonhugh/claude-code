import { resetSettingsCache } from '../utils/settings/settingsCache.js'
import { beforeEach, afterEach, expect, test } from 'bun:test'
import React, { useRef, useState, useSyncExternalStore } from 'react'
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { Readable, Writable } from 'node:stream'
import { ThemeProvider, render } from '../ink.js'
import instances from '../ink/instances.js'
import type { DOMElement, DOMNode } from '../ink/dom.js'
import { getFocusManager } from '../ink/focus.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'
import { useOptionalKeybindingContext, useRegisterKeybindingContext } from '../keybindings/KeybindingContext.js'
import { AppStoreContext, getDefaultAppState } from '../state/AppState.js'
import { createStore } from '../state/store.js'
import { createModsRuntime, type ModDiagnostic } from '../services/mods/runtime.js'
import type { ModUiPresentation, ModUiPane } from '../services/mods/ui.js'
import type { PastedContent } from '../utils/config.js'
import type { PromptInputHandle, PromptInputMode, VimMode } from '../types/textInputTypes.js'
import PromptInput from './PromptInput/PromptInput.js'
import { ModsAbovePrompt } from './ModsAbovePrompt.js'
import { ModsPane } from './ModsPane.js'

const testEnvKeys = [
  'HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
]
let testConfigRoot: string | undefined
let savedTestEnvironment: (string | undefined)[] = []
beforeEach(async () => {
  savedTestEnvironment = testEnvKeys.map(key => process.env[key])
  testConfigRoot = await realpath(await mkdtemp(join(tmpdir(), 'mods-test-config-')))
  process.env.HOME = testConfigRoot
  process.env.CLAUDE_CONFIG_DIR = join(testConfigRoot, 'config')
  process.env.XDG_CONFIG_HOME = join(testConfigRoot, 'xdg-config')
  process.env.XDG_CACHE_HOME = join(testConfigRoot, 'xdg-cache')
  process.env.XDG_STATE_HOME = join(testConfigRoot, 'xdg-state')
  process.env.ANTHROPIC_API_KEY = 'sk-test-placeholder'
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  delete process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
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

const PLUGIN = 'band-focus-owner'
type Policy = 'accept' | 'deny' | 'withhold' | 'rewrite' | 'pending'
function actualREPLAdmission(name: 'modAbovePromptCanFocus' | 'modPaneFocused') {
  const source = readFileSync(new URL('../screens/REPL.tsx', import.meta.url), 'utf8')
  const file = ts.createSourceFile('REPL.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const expressions: ts.Expression[] = []
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name && node.initializer)
      expressions.push(node.initializer)
    ts.forEachChild(node, visit)
  }
  visit(file)
  expect(expressions).toHaveLength(1)
  return new Function('modUiPresentation', 'modPaneFocused', 'modPanes', `return (${expressions[0]!.getText(file)});`) as
    (presentation: ModUiPresentation, paneFocused: boolean, panes: readonly ModUiPane[]) => boolean
}
function actualREPLPromptBlock() {
  const source = readFileSync(new URL('../screens/REPL.tsx', import.meta.url), 'utf8')
  const file = ts.createSourceFile('REPL.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const expressions: ts.Expression[] = []
  function visit(node: ts.Node) {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(file) === 'PromptInput') {
      for (const attribute of node.attributes.properties) {
        if (ts.isJsxAttribute(attribute) && attribute.name.getText(file) === 'isLocalJSXCommandActive' &&
            attribute.initializer && ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression)
          expressions.push(attribute.initializer.expression)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  expect(expressions).toHaveLength(1)
  return new Function('isShowingLocalJSXCommand', 'showResponsiveDiffDialog', 'modPaneFocused', 'modAbovePromptFocused',
    `return (${expressions[0]!.getText(file)});`) as (...values: boolean[]) => boolean
}
class Input extends Readable {
  isTTY = true
  _read() {}
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
class Output extends Writable {
  columns = 120
  rows = 40
  isTTY = true
  _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void) { done() }
}
function textOf(node: DOMNode): string {
  return node.nodeName === '#text' ? node.nodeValue : node.childNodes.map(textOf).join('')
}
function findText(root: DOMElement, value: string): DOMElement | undefined {
  if (root.nodeName === 'ink-text' && textOf(root) === value) return root
  for (const child of root.childNodes) {
    if (child.nodeName === '#text') continue
    const result = findText(child, value)
    if (result) return result
  }
  return undefined
}
async function waitFor(done: () => boolean, phase: string, evidence: () => unknown) {
  const deadline = Date.now() + 1000
  while (!done() && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
  if (!done()) console.error('Band canonical focus barrier:', JSON.stringify({ phase, evidence: evidence() }))
  expect(done()).toBe(true)
}

async function mount(policy: Policy = 'accept', secondOwner = false, paneIds: readonly string[] = [], band = true) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'mods-focus-chord-')))
  const entry = join(directory, 'register.ts')
  const focus = policy === 'deny' ? "const result={deny:'band held'};"
    : policy === 'withhold' ? 'const result={};'
    : policy === 'rewrite' ? "const result=await next({element:'other'});"
    : policy === 'pending' ? 'await $.clock.sleep(0);const result=await next(e);'
    : 'const result=await next(e);'
  await writeFile(entry, `export function register(on) {
    ${paneIds.length ? `on('session.start',async($,e,next)=>{for(const id of ${JSON.stringify(paneIds)})await $.ui.open({id,rows:5});return next(e)});
    on('ui.render',{component:'Pane'},($,e)=>{const {Box,Text,Button}=$.ui.resolve(e);return Box({flexDirection:'column',children:[Text({children:'PANE '+e.requestId}),Button({key:'pane-action',label:'Press '+e.requestId,hotkey:'p',onPress:event=>$.ui.status(JSON.stringify({kind:'pane-press',event}))})]})});` : ''}
    ${band ? `on('ui.render',{component:'AbovePrompt'},${secondOwner ? 'async' : ''}($,e${secondOwner ? ',next' : ''})=>{const {Box,Text,Button}=$.ui.resolve(e);return Box({flexDirection:'column',children:[
      Text({children:'BAND canonical author'}),
      Button({key:'increment',label:'First',onPress:event=>$.ui.status(JSON.stringify({kind:'press',element:'increment',event}))}),
      Button({key:'other',label:'Second',onPress:event=>$.ui.status(JSON.stringify({kind:'press',element:'other',event}))})${secondOwner ? ',await next(e)' : ''}]})});` : ''}
    on('ui.focus',async($,e,next)=>{
      await $.ui.status(JSON.stringify({kind:'focus-enter',event:e,caller:next.origin}));
      ${focus}
      await $.ui.status(JSON.stringify({kind:'focus-result',event:e,result}));return result;
    });
    on('command.run',{command:'band-public-focus'},async($,e)=>{const result=await $.ui.focus({requestId:e.args==='missing'?'missing':'above-prompt',key:'increment'});return {text:JSON.stringify(result)}});
  }`)
  const stdin = new Input(), stdout = new Output()
  if (paneIds.length) stdout.columns = 160
  const state = getDefaultAppState(), store = createStore(state)
  const receipts: { plugin: string; value: Record<string, unknown> }[] = []
  const gate = Promise.withResolvers<void>()
  let clockGateEntered = false
  const bandAdmission = actualREPLAdmission('modAbovePromptCanFocus')
  const paneAdmission = actualREPLAdmission('modPaneFocused')
  const promptBlock = actualREPLPromptBlock()
  let paneHeld = false
  const diagnostics: ModDiagnostic[] = [], errors: unknown[] = []
  let held = false, committedInput = ''
  let presentationWork = Promise.resolve()
  let showBand: (shown: boolean) => void
  let bindingContext: ReturnType<typeof useOptionalKeybindingContext>
  let editor: React.RefObject<PromptInputHandle | null>
  const presentationRef: { current: ModUiPresentation } = { current: {
    columns: stdout.columns, rows: stdout.rows, isFullscreen: false,
    composerEmpty: true, hasDialog: false, keyboardOwned: false,
  } }
  const runtime = createModsRuntime({
    onDiagnostic: event => diagnostics.push(event),
    services: {
      uiPresentation: () => presentationRef.current,
      uiStatus: (plugin, text) => {
        if (text === undefined) return
        const value = JSON.parse(text)
        receipts.push({ plugin, value })
      },
    },
  })
  if (policy === 'pending') runtime.registerHostHook({
    plugin: 'band-delay-gate', tier: 'prepend', registration: { id: 1, event: 'clock.sleep', hasCatch: false },
    async invoke(input, next) { clockGateEntered = true;await gate.promise;return next(input) },
  })
  function Host() {
    const [input, setInput] = useState('')
    const [shown, setShown] = useState(true)
    showBand = setShown
    const [focused, setFocused] = useState(false)
    const [mode, setMode] = useState<PromptInputMode>('prompt')
    const [pastedContents, setPastedContents] = useState<Record<number, PastedContent>>({})
    const [vimMode, setVimMode] = useState<VimMode>('INSERT')
    const [helpOpen, setHelpOpen] = useState(false)
    editor = useRef(null)
    bindingContext = useOptionalKeybindingContext()
    useRegisterKeybindingContext('Chat')
    const currentPanes = useSyncExternalStore(runtime.ui.subscribe, runtime.ui.getSnapshot)
    const presentation = React.useMemo(() => ({
      columns: stdout.columns, rows: stdout.rows, isFullscreen: false,
      composerEmpty: input.length === 0 && Object.keys(pastedContents).length === 0,
      hasDialog: false, keyboardOwned: false,
      composerValue: input,
    }), [input, pastedContents])
    const paneFocused = paneAdmission(presentation, false, currentPanes)
    React.useLayoutEffect(() => { held = focused; paneHeld = paneFocused; committedInput = input })
    presentationRef.current = presentation
    React.useEffect(() => { presentationWork = runtime.ui.render(presentation).catch(error => { errors.push(error) }) }, [presentation])
    return <>
      {shown && <ModsAbovePrompt ui={runtime.ui} hasSurvey={false} isWorking={false} view={{}}
        composerValue={input} canFocus={bandAdmission(presentation, paneFocused, currentPanes)} onFocusChange={setFocused} onError={error => errors.push(error)} />}
      {currentPanes.filter(pane => pane.visible).map(pane => <ModsPane key={pane.id} pane={pane}
        canFocus={!focused && !paneFocused && presentation.composerEmpty}
        onInteract={(pane, drawing, callback, kind, element, value) => runtime.ui.interact(pane.id, drawing, callback, kind, element, value)}
        onClose={pane => runtime.ui.close(pane.owner, pane.id, { kind: 'person' })}
        onFocus={(pane, element, origin = { kind: 'person' }, options) => origin.kind === 'plugin' && origin.name !== undefined && element !== undefined
          ? runtime.ui.focusHost(pane.owner, { requestId: pane.id, element, origin: { kind: 'plugin', name: origin.name } }, presentationRef.current, options)
          : runtime.ui.focus(pane.owner, { requestId: pane.id, element, origin }, presentationRef.current)}
        onScroll={(pane, by, pointer) => runtime.ui.scroll(pane.owner, { requestId: pane.id, by, pointer, origin: { kind: 'person' } })}
        onReportMetrics={(pane, metrics) => runtime.ui.reportMetrics(pane.id, metrics)} onError={error => errors.push(error)} />)}
      <PromptInput debug={false} ideSelection={undefined}
        toolPermissionContext={state.toolPermissionContext} setToolPermissionContext={() => {}}
        apiKeyStatus="valid" commands={[]} agents={[]} enableLocalIOCompletions={false}
        isLoading={false} isAssistantResponding={false} verbose={false} messages={[]}
        onAutoUpdaterResult={() => {}} autoUpdaterResult={null} input={input} onInputChange={setInput}
        mode={mode} onModeChange={setMode} stashedPrompt={undefined} setStashedPrompt={() => {}}
        submitCount={0} onShowMessageSelector={() => {}} mcpClients={[]}
        pastedContents={pastedContents} setPastedContents={setPastedContents}
        vimMode={vimMode} setVimMode={setVimMode} showBashesDialog={false} setShowBashesDialog={() => {}}
        onExit={() => {}} getToolUseContext={() => { throw new Error('No query in Band source test') }}
        onSubmit={async () => { throw new Error('No submit in Band source test') }}
        isSearchingHistory={false} setIsSearchingHistory={() => {}}
        helpOpen={helpOpen} setHelpOpen={setHelpOpen}
        isLocalJSXCommandActive={promptBlock(false, false, paneFocused, focused)} insertTextRef={editor}
      />
    </>
  }
  await runtime.bind({ cwd: directory, sessionId: 'band-focus-chord', surface: 'terminal', isInteractive: true })
  const instance = await render(<ThemeProvider><AppStoreContext value={store}><KeybindingSetup><Host /></KeybindingSetup></AppStoreContext></ThemeProvider>, {
    stdin: stdin as never, stdout: stdout as never, stderr: stdout as never, patchConsole: false, exitOnCtrlC: false,
  })
  function root() { return (instances.get(stdout as never) as unknown as { rootNode: DOMElement }).rootNode }
  function bandRoot() {
    for (let node = findText(root(), 'BAND canonical author'); node; node = node.parentNode) {
      if (node.style.selectionScope === true && typeof node._eventHandlers?.onKeyDown === 'function') return node
    }
    return undefined
  }
  function paneRoot(id: string) {
    for (let node = findText(root(), 'PANE ' + id); node; node = node.parentNode) {
      if (node.style.selectionScope === true && typeof node._eventHandlers?.onKeyDown === 'function') return node
    }
    return undefined
  }
  function button(label: 'First' | 'Second' | 'Third') {
    for (let node = findText(root(), `[ ${label} ]`); node; node = node.parentNode) {
      if (typeof node.attributes.tabIndex === 'number') return node
    }
    return undefined
  }
  function values(kind: string) { return receipts.filter(row => row.value.kind === kind).map(row => row.value) }
  function evidence() {
    const band = bandRoot()
    return { policy, held, paneHeld, panes: runtime.ui.getSnapshot().map(pane => ({ id: pane.id, visible: pane.visible, shown: pane.shown, focused: pane.focused, focusedElement: pane.focusedElement })), committedInput, clockGateEntered, editor: editor?.current && { text: editor.current.text, cursor: editor.current.cursorOffset },
      pendingChord: bindingContext?.pendingChord, receipts, diagnostics, errors: errors.map(String),
      active: band && getFocusManager(band).activeElement === button('First') ? 'First'
        : band && getFocusManager(band).activeElement === button('Second') ? 'Second' : 'outside',
    }
  }
  async function raw(bytes: string) {
    stdin.push(bytes)
    await new Promise(resolve => setImmediate(resolve))
  }
  async function canonical(waitForResult = true) {
    const count = values(waitForResult ? 'focus-result' : 'focus-enter').length
    await raw('\x18')
    await waitFor(() => bindingContext?.pendingChord !== null && bindingContext?.pendingChord !== undefined, 'actual Ctrl-X pending', evidence)
    await raw('\t')
    await waitFor(() => values(waitForResult ? 'focus-result' : 'focus-enter').length === count + 1 &&
      (waitForResult || clockGateEntered), 'actual author focus receipt', evidence)
  }
  async function dispose() {
    gate.resolve()
    instance.unmount();instance.cleanup()
    try { await runtime.dispose() }
    finally { stdin.destroy();stdout.destroy();await rm(directory, { recursive: true, force: true }) }
  }
  try {
    const owner = { name: PLUGIN, storageId: PLUGIN + '@test', pluginRoot: directory, entrypoints: [entry] }
    if (secondOwner) {
      const other = join(directory, 'other.ts')
      await writeFile(other, `export function register(on) {
        on('ui.render',{component:'AbovePrompt'},($,e)=>{const {Button}=$.ui.resolve(e);return Button({key:'increment',label:'Third',onPress:event=>$.ui.status(JSON.stringify({kind:'press',element:'increment',event}))})});
      }`)
      await runtime.reconcile([{ ...owner, tier: 'prepend' }, { name: 'band-other-owner', storageId: 'band-other-owner@test', pluginRoot: directory, entrypoints: [other] }])
    } else await runtime.reconcile([owner])
    await waitFor(() => Boolean(editor.current && bindingContext && (band ? bandRoot() && findText(root(), '[ First ]') : paneIds.every(id => paneRoot(id)))), 'real Worker drawing, PromptInput and default KeybindingSetup', evidence)
  } catch (error) { await dispose(); throw error }
  return { runtime, raw, canonical, dispose, values, evidence, bandRoot, paneRoot, button, receipts, diagnostics, errors, release: gate.resolve,
    showBand: (shown: boolean) => showBand(shown),
    get editor() { return editor.current! }, get held() { return held }, get paneHeld() { return paneHeld }, get pending() { return bindingContext?.pendingChord },
    settlePresentation: async () => {
      let current: Promise<void>
      do {
        current = presentationWork
        await current
        await new Promise(resolve => setImmediate(resolve))
      } while (current !== presentationWork)
    },
    get hidden() { return textOf(root()).includes('▸ plugin panel hidden') },
    get focusedPanes() { return runtime.ui.getSnapshot().filter(pane => pane.visible && pane.shown !== false && pane.focused).map(pane => pane.id) },
  }
}

function expectedFocus() {
  return { component: 'AbovePrompt', requestId: 'above-prompt', plugin: PLUGIN, element: 'increment', origin: { kind: 'person' } }
}
for (const policy of ['accept', 'rewrite'] as const) {
  test(`canonical default chord negotiates ${policy} with the actual Band Worker and activates the published Button`, async () => {
    const h = await mount(policy)
    try {
      expect(h.held).toBe(false)
      await h.canonical()
      const destination = policy === 'rewrite' ? 'Second' : 'First'
      await waitFor(() => h.held && getFocusManager(h.bandRoot()!).activeElement === h.button(destination), 'actual acknowledged DOM landing', h.evidence)
      expect(h.values('focus-enter')).toEqual([{ kind: 'focus-enter', event: expectedFocus(), caller: { plugin: 'engine', tier: 'core' } }])
      expect(h.pending).toBeNull()
      await h.raw(' ')
      await waitFor(() => h.values('press').length === 1, 'actual Button callback', h.evidence)
      expect(h.values('press')[0]).toMatchObject({ element: policy === 'rewrite' ? 'other' : 'increment', event: { plugin: PLUGIN, element: policy === 'rewrite' ? 'other' : 'increment', requestId: 'above-prompt', component: 'AbovePrompt' } })
      expect({ text: h.editor.text, cursor: h.editor.cursorOffset }).toEqual({ text: '', cursor: 0 })
      expect({ errors: h.errors, diagnostics: h.diagnostics }).toEqual({ errors: [], diagnostics: [] })
    } finally { await h.dispose() }
  })
}
for (const policy of ['deny', 'withhold'] as const) {
  test(`canonical Band ${policy} retains the body holder without activating either Button`, async () => {
    const h = await mount(policy)
    try {
      await h.canonical()
      expect(h.values('focus-enter')[0]).toMatchObject({ event: expectedFocus() })
      await waitFor(() => h.held && getFocusManager(h.bandRoot()!).activeElement === h.bandRoot(), 'refusal retains the official empty body holder', h.evidence)
      expect(h.pending).toBeNull()
      await h.raw('z')
      expect(h.editor.text).toBe('')
      expect(getFocusManager(h.bandRoot()!).activeElement).toBe(h.bandRoot())
      expect(h.values('press')).toEqual([])
    } finally { await h.dispose() }
  })
}
for (const bytes of ['\t', '\x1b[Z']) {
  test(`unheld Band leaves bare ${bytes === '\t' ? 'Tab' : 'Shift-Tab'} ownership with real PromptInput`, async () => {
    const h = await mount()
    try {
      await h.raw(bytes)
      await h.raw('z')
      await waitFor(() => h.editor.text === 'z', 'bare Tab must not enter Band', h.evidence)
      expect(h.held).toBe(false)
      expect(h.values('focus-enter')).toEqual([])
      expect(h.values('press')).toEqual([])
    } finally { await h.dispose() }
  })
}
test('public plugin focus cannot enter an unheld Band', async () => {
  const h = await mount()
  try {
    const result = await h.runtime.dispatch('command.run', { command: 'band-public-focus', args: '', origin: { kind: 'composer' }, presentation: { kind: 'text' } }, async () => ({})) as { text: string }
    expect(JSON.parse(result.text)).toMatchObject({ deny: expect.any(String) })
    expect(h.values('focus-enter')).toEqual([])
    expect(h.held).toBe(false)
  } finally { await h.dispose() }
})

test('public focus of the held own Band keeps the official result shape and plugin origin', async () => {
  const h = await mount()
  try {
    await h.canonical()
    const result = await h.runtime.dispatch('command.run', { command: 'band-public-focus', args: '', origin: { kind: 'composer' }, presentation: { kind: 'text' } }, async () => ({})) as { text: string }
    expect(JSON.parse(result.text)).toEqual({})
    expect(h.values('focus-enter')).toHaveLength(2)
    expect(h.values('focus-enter')[1]).toMatchObject({ event: { ...expectedFocus(), origin: { kind: 'plugin', name: PLUGIN } } })
    expect(h.held).toBe(true)
  } finally { await h.dispose() }
})

test('explicit canonical Band entry preserves a nonempty draft and cursor until the actual value changes', async () => {
  const h = await mount()
  try {
    await h.raw('draft')
    await waitFor(() => h.editor.text === 'draft', 'actual nonempty composer', h.evidence)
    await h.raw('\x1b[D\x1b[D\x1b[D')
    expect(h.editor.cursorOffset).toBe(2)
    await h.canonical()
    await waitFor(() => h.held && getFocusManager(h.bandRoot()!).activeElement === h.button('First'), 'explicit nonempty Band landing', h.evidence)
    expect({ text: h.editor.text, cursor: h.editor.cursorOffset }).toEqual({ text: 'draft', cursor: 2 })
    await h.raw(' ')
    await waitFor(() => h.values('press').length === 1, 'nonempty entry Button callback', h.evidence)
    expect({ text: h.editor.text, cursor: h.editor.cursorOffset }).toEqual({ text: 'draft', cursor: 2 })
    h.editor.setInputWithCursor('changed', 3)
    await waitFor(() => !h.held && h.editor.text === 'changed', 'actual composer value change releases holder', h.evidence)
  } finally { await h.dispose() }
})

test('Escape while the actual author focus is pending prevents its late receipt from reviving the Band', async () => {
  const h = await mount('pending')
  try {
    await h.canonical(false)
    expect(h.values('focus-result')).toEqual([])
    await h.raw('\x1b')
    await waitFor(() => !h.held, 'actual Escape releases body before author resumes', h.evidence)
    h.release()
    await waitFor(() => h.values('focus-result').length === 1, 'late author receipt', h.evidence)
    expect(h.values('focus-result')[0]).toMatchObject({ result: { deny: expect.any(String) } })
    expect(h.held).toBe(false)
    await h.raw('z')
    await waitFor(() => h.editor.text === 'z', 'composer after abandoned move', h.evidence)
    expect(h.values('press')).toEqual([])
  } finally { await h.dispose() }
})

test('two canonical chords in one stdin read negotiate the next actual control and clear pending state', async () => {
  const h = await mount()
  try {
    await h.raw('\x18\t\x18\t')
    await waitFor(() => h.values('focus-result').length === 2, 'both actual queued person negotiations', h.evidence)
    expect(h.values('focus-enter').map(row => row.event)).toEqual([expectedFocus(), { ...expectedFocus(), element: 'other' }])
    await waitFor(() => h.held && getFocusManager(h.bandRoot()!).activeElement === h.button('Second'), 'queued second control DOM landing', h.evidence)
    expect(h.pending).toBeNull()
    await h.raw(' ')
    await waitFor(() => h.values('press').length === 1, 'queued second Button callback', h.evidence)
    expect(h.values('press')[0]).toMatchObject({ element: 'other' })
    expect(h.editor.text).toBe('')
  } finally { await h.dispose() }
})

test('canonical navigation keeps same-key controls of different plugins distinct and denies a cross-owner public move', async () => {
  const h = await mount('accept', true)
  try {
    await h.canonical();await h.canonical();await h.canonical()
    await waitFor(() => getFocusManager(h.bandRoot()!).activeElement === h.button('Third'), 'actual other-plugin same-key landing', h.evidence)
    expect(h.values('focus-enter')[2]).toMatchObject({ event: { ...expectedFocus(), plugin: 'band-other-owner' } })
    await h.raw(' ')
    await waitFor(() => h.values('press').length === 1, 'other-plugin callback', h.evidence)
    expect(h.receipts.find(row => row.value.kind === 'press')).toMatchObject({ plugin: 'band-other-owner', value: { event: { plugin: 'band-other-owner', element: 'increment' } } })
    const result = await h.runtime.dispatch('command.run', { command: 'band-public-focus', args: '', origin: { kind: 'composer' }, presentation: { kind: 'text' } }, async () => ({})) as { text: string }
    expect(JSON.parse(result.text)).toMatchObject({ deny: "another plugin's element holds the keyboard" })
    expect(h.values('focus-enter')).toHaveLength(3)
    expect(getFocusManager(h.bandRoot()!).activeElement).toBe(h.button('Third')!)
  } finally { await h.dispose() }
})

test('public focus cannot expand a collapsed Band or revive its previous holder', async () => {
  const h = await mount()
  try {
    await h.canonical()
    await h.raw('\x18\x01')
    await waitFor(() => h.hidden && !h.held, 'actual collapsed Band', h.evidence)
    const result = await h.runtime.dispatch('command.run', { command: 'band-public-focus', args: '', origin: { kind: 'composer' }, presentation: { kind: 'text' } }, async () => ({})) as { text: string }
    expect(JSON.parse(result.text)).toMatchObject({ deny: expect.any(String) })
    expect(h.hidden).toBe(true)
    expect(h.held).toBe(false)
    expect(h.values('focus-enter')).toHaveLength(1)
  } finally {
    if (h.hidden) { await h.raw('\x18\x01');await waitFor(() => !h.hidden, 'restore by real expand shortcut', h.evidence) }
    await h.dispose()
  }
})

test('an actual draft change while author focus is pending fences the late commit', async () => {
  const h = await mount('pending')
  try {
    await h.canonical(false)
    h.editor.setInputWithCursor('changed', 3)
    await waitFor(() => !h.held && h.editor.text === 'changed', 'real value change while focus is pending', h.evidence)
    h.release()
    await waitFor(() => h.values('focus-result').length === 1, 'late focus after value change', h.evidence)
    expect(h.values('focus-result')[0]).toMatchObject({ result: { deny: expect.any(String) } })
    expect(h.held).toBe(false)
    expect({ text: h.editor.text, cursor: h.editor.cursorOffset }).toEqual({ text: 'changed', cursor: 3 })
    expect(h.values('press')).toEqual([])
  } finally { await h.dispose() }
})

test('a pending old Band focus cannot commit into a remounted render site', async () => {
  const h = await mount('pending')
  try {
    await h.canonical(false)
    h.showBand(false)
    await waitFor(() => !h.bandRoot() && !h.held, 'old component and holder actually unmounted', h.evidence)
    h.showBand(true)
    await waitFor(() => Boolean(h.bandRoot()), 'new independent render site actually mounted', h.evidence)
    h.release()
    await waitFor(() => h.values('focus-result').length === 1, 'old author receipt after remount', h.evidence)
    expect(h.values('focus-result')[0]).toMatchObject({ result: { deny: expect.any(String) } })
    expect(h.held).toBe(false)
    await h.raw('z')
    await waitFor(() => h.editor.text === 'z', 'composer after old site receipt', h.evidence)
    expect(h.values('press')).toEqual([])
  } finally { await h.dispose() }
})

test('public focus of a missing site returns the official ownership denial before any hook', async () => {
  const h = await mount()
  try {
    const result = await h.runtime.dispatch('command.run', { command: 'band-public-focus', args: 'missing', origin: { kind: 'composer' }, presentation: { kind: 'text' } }, async () => ({})) as { text: string }
    expect(JSON.parse(result.text)).toEqual({ deny: "not this plugin's site" })
    expect(h.values('focus-enter')).toEqual([])
    expect(h.held).toBe(false)
    expect({ text: h.editor.text, cursor: h.editor.cursorOffset }).toEqual({ text: '', cursor: 0 })
  } finally { await h.dispose() }
})


test('canonical full cycle visits both actual Pane bodies after the Band and then returns to composer', async () => {
  const h = await mount('accept', false, ['first-pane', 'second-pane'])
  try {
    await h.canonical();await h.canonical()
    expect(h.values('focus-enter').map(row => row.event)).toEqual([expectedFocus(), { ...expectedFocus(), element: 'other' }])
    await h.raw('\x18\t')
    await waitFor(() => h.focusedPanes[0] === 'first-pane' && !h.held, 'canonical Band last to actual first Pane body', h.evidence)
    await waitFor(() => getFocusManager(h.paneRoot('first-pane')!).activeElement === h.paneRoot('first-pane'), 'actual first Pane body after published snapshot', h.evidence)
    expect(getFocusManager(h.paneRoot('first-pane')!).activeElement).toBe(h.paneRoot('first-pane')!)
    expect(h.values('focus-enter')).toHaveLength(2)
    await h.raw('p')
    await waitFor(() => h.values('pane-press').length === 1, 'actual held first Pane hotkey callback', h.evidence)
    expect(h.values('pane-press')[0]).toMatchObject({ event: { component: 'Pane', requestId: 'first-pane', plugin: PLUGIN, element: 'pane-action' } })
    await h.raw('\x18\t')
    await waitFor(() => h.focusedPanes[0] === 'second-pane', 'actual second Pane body', h.evidence)
    await waitFor(() => getFocusManager(h.paneRoot('second-pane')!).activeElement === h.paneRoot('second-pane'), 'actual second Pane body after published snapshot', h.evidence)
    expect(getFocusManager(h.paneRoot('second-pane')!).activeElement).toBe(h.paneRoot('second-pane')!)
    expect(h.values('focus-enter')).toHaveLength(2)
    await h.raw('\x18\t')
    await waitFor(() => h.focusedPanes.length === 0 && !h.held, 'last Pane to composer only', h.evidence)
    await h.raw('z')
    await waitFor(() => h.editor.text === 'z', 'actual composer after full cycle', h.evidence)
    expect(h.pending).toBeNull()
    expect(h.errors).toEqual([])
  } finally { await h.dispose() }
})

test('canonical only Pane works while the actual AbovePrompt drawing is engine fallback', async () => {
  const h = await mount('accept', false, ['only-pane'], false)
  try {
    expect(h.bandRoot()).toBeUndefined()
    await h.raw('\x18\t')
    await waitFor(() => h.focusedPanes[0] === 'only-pane', 'fallback Band still lets canonical enter actual Pane', h.evidence)
    await waitFor(() => getFocusManager(h.paneRoot('only-pane')!).activeElement === h.paneRoot('only-pane'), 'canonical body after fallback snapshot', h.evidence)
    expect(getFocusManager(h.paneRoot('only-pane')!).activeElement).toBe(h.paneRoot('only-pane')!)
    expect(h.values('focus-enter')).toEqual([])
    await h.settlePresentation()
    await h.raw('p')
    await waitFor(() => h.values('pane-press').length === 1, 'body-owned real pane hotkey', h.evidence)
    expect(h.editor.text).toBe('')
    expect(h.errors).toEqual([])
  } finally { await h.dispose() }
})


test('canonical only Pane preserves actual nonempty draft and cursor until a value change releases its holder', async () => {
  const h = await mount('accept', false, ['draft-pane'], false)
  try {
    await h.raw('draft')
    await waitFor(() => h.editor.text === 'draft', 'real pane-entry draft', h.evidence)
    await h.settlePresentation()
    await h.raw('\x1b[D\x1b[D\x1b[D')
    expect(h.editor.cursorOffset).toBe(2)
    await h.raw('\x18\t')
    await waitFor(() => h.focusedPanes[0] === 'draft-pane' && h.paneHeld, 'actual REPL admission holds nonempty canonical Pane', h.evidence)
    await h.settlePresentation()
    expect({ text: h.editor.text, cursor: h.editor.cursorOffset }).toEqual({ text: 'draft', cursor: 2 })
    await h.raw('p')
    await waitFor(() => h.values('pane-press').length === 1, 'real Pane owns hotkey with nonempty composer', h.evidence)
    expect({ text: h.editor.text, cursor: h.editor.cursorOffset }).toEqual({ text: 'draft', cursor: 2 })
    h.editor.setInputWithCursor('changed', 3)
    await waitFor(() => h.focusedPanes.length === 0 && !h.paneHeld, 'actual draft value change releases canonical Pane', h.evidence)
    expect({ text: h.editor.text, cursor: h.editor.cursorOffset }).toEqual({ text: 'changed', cursor: 3 })
  } finally { await h.dispose() }
})

test('canonical full cycle handles six chords in one stdin read with the official receipt-time Band branch', async () => {
  const h = await mount('accept', false, ['burst-first', 'burst-second'])
  try {
    await h.raw('\x18\t'.repeat(6))
    await waitFor(() => h.values('focus-result').length === 2 && h.held && h.focusedPanes.length === 0, 'same-read official Band moves settle at the last control', h.evidence)
    expect(h.values('focus-enter').map(row => row.event)).toEqual([expectedFocus(), { ...expectedFocus(), element: 'other' }])
    expect(getFocusManager(h.bandRoot()!).activeElement).toBe(h.button('Second')!)
    expect(h.pending).toBeNull()
    await h.raw(' ')
    await waitFor(() => h.values('press').length === 1, 'real last Button after six queued chords', h.evidence)
    expect(h.values('press')[0]).toMatchObject({ element: 'other' })
    expect(h.editor.text).toBe('')
  } finally { await h.dispose() }
})

test('canonical queued cycle Escape abandons later accepted steps after a pending actual focus', async () => {
  const h = await mount('pending', false, ['escape-pane'])
  try {
    await h.raw('\x18\t'.repeat(3))
    await waitFor(() => h.values('focus-enter').length === 1 && h.evidence().clockGateEntered, 'actual first queued focus at clock gate', h.evidence)
    await h.raw('\x1b')
    await waitFor(() => !h.held, 'real Escape before queued cycle resumes', h.evidence)
    h.release()
    await waitFor(() => h.values('focus-result').length >= 1, 'first late reply actually completes', h.evidence)
    await h.raw('z')
    await waitFor(() => h.editor.text === 'z', 'composer after abandoned queued cycle', h.evidence)
    expect(h.values('focus-enter')).toHaveLength(1)
    expect(h.focusedPanes).toEqual([])
    expect(h.held).toBe(false)
  } finally { await h.dispose() }
})


test.each(['\t', '\x1b[Z'])('unheld actual Pane leaves bare Tab or Shift-Tab ownership with the composer (%j)', async key => {
  const h = await mount('accept', false, ['bare-tab-pane'], false)
  try {
    await h.raw(key)
    expect(h.values('focus-enter')).toEqual([])
    expect(h.focusedPanes).toEqual([])
    expect(h.held).toBe(false)
    expect(h.pending).toBeNull()
    await h.raw('z')
    await waitFor(() => h.editor.text === 'z', 'composer after unclaimed Tab with a real Pane', h.evidence)
    expect(h.values('pane-press')).toEqual([])
  } finally { await h.dispose() }
})

for (const control of [false, true]) {
  test(`unhandled literal input leaves the actual Pane ${control ? 'Button' : 'body'} for the composer`, async () => {
    const h = await mount('accept', false, ['type-pane'], false)
    try {
      await h.raw('\x18\t')
      await waitFor(() => h.paneHeld && h.focusedPanes[0] === 'type-pane', 'actual Pane holder before typing', h.evidence)
      await h.settlePresentation()
      if (control) {
        await h.raw('\t')
        await waitFor(() => h.values('focus-result').length === 1, 'actual drawn Button focus receipt', h.evidence)
      }
      const focuses = h.values('focus-enter').length
      await h.raw('/exit')
      await waitFor(() => h.editor.text === '/exit' && !h.paneHeld && h.focusedPanes.length === 0,
        'unhandled real text reaches composer and releases Pane', h.evidence)
      expect({text: h.editor.text, cursor: h.editor.cursorOffset}).toEqual({text: '/exit', cursor: 5})
      expect(h.values('focus-enter')).toHaveLength(focuses)
      expect(h.values('pane-press')).toEqual([])
      expect(h.errors).toEqual([])
      expect(h.diagnostics).toEqual([])
    } finally { await h.dispose() }
  })
}
