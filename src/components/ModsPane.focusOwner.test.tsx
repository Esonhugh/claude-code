import { resetSettingsCache } from '../utils/settings/settingsCache.js'
import { beforeEach, afterEach, expect, test } from 'bun:test'
import React, { useRef, useState, useSyncExternalStore } from 'react'
import { Readable, Writable } from 'node:stream'
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ThemeProvider, render } from '../ink.js'
import instances from '../ink/instances.js'
import type { DOMElement, DOMNode } from '../ink/dom.js'
import { getFocusManager } from '../ink/focus.js'
import { AppStoreContext, getDefaultAppState } from '../state/AppState.js'
import { createStore } from '../state/store.js'
import type { PastedContent } from '../utils/config.js'
import type { PromptInputHandle, PromptInputMode, TextInputEdit } from '../types/textInputTypes.js'
import { createModsRuntime, type ModDiagnostic } from '../services/mods/runtime.js'
import { createModPromptEditQueue, runModPromptEdit } from '../services/mods/promptEdit.js'
import type { ModUiCallback, ModUiPane, ModUiPresentation } from '../services/mods/ui.js'
import PromptInput from './PromptInput/PromptInput.js'
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

const PLUGIN = 'focus-owner'
const PANE = 'focus-panel'
class Input extends Readable {
  isTTY = true
  _read() {}
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
class Output extends Writable {
  columns = 160
  rows = 40
  isTTY = true
  _write(_chunk: Buffer, _encoding: BufferEncoding, done: () => void) { done() }
}
type AuthorReceipt = { plugin: string; value: Record<string, unknown> }
async function waitFor(done: () => boolean, phase: string, evidence: () => unknown) {
  const deadline = Date.now() + 1000
  while (!done() && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
  if (!done()) console.error('UI1 focus-owner barrier:', JSON.stringify({ phase, evidence: evidence() }))
  expect(done()).toBe(true)
}
function textOf(node: DOMNode): string {
  return node.nodeName === '#text' ? node.nodeValue : node.childNodes.map(textOf).join('')
}
function findText(root: DOMElement, text: string): DOMElement | undefined {
  if (root.nodeName === 'ink-text' && textOf(root) === text) return root
  for (const child of root.childNodes) {
    if (child.nodeName === '#text') continue
    const found = findText(child, text)
    if (found) return found
  }
  return undefined
}
function isWithin(node: DOMElement | null, root: DOMElement): boolean {
  for (let current = node; current; current = current.parentNode ?? null) {
    if (current === root) return true
  }
  return false
}
function callbackOf(tree: unknown, key: string): ModUiCallback | undefined {
  if (tree && typeof tree === 'object') {
    const node = tree as { props?: { key?: string }; press?: ModUiCallback; children?: unknown[] }
    if (node.props?.key === key && node.press) return node.press
    for (const child of node.children ?? []) {
      const found = callbackOf(child, key)
      if (found) return found
    }
  }
  return undefined
}
function authorSource(initialFocus: boolean, field: boolean) {
  return [
    'let draws=0; export function register(on) {',
    'on("session.start",async($,e,next)=>{await $.ui.open({id:"' + PANE + '",rows:5' + (initialFocus ? ',focus:true' : '') + '});return next(e)});',
    'on("ui.render",{component:"Pane"},($,e)=>{const {Box,Text,Button,Input}=$.ui.resolve(e);draws++;return Box({flexDirection:"column",children:[',
    'Text({children:"author drawing:"+draws}),',
    field ? 'Input({key:"field",placeholder:"author field",autoFocus:true,onInput:(value,event)=>$.ui.status(JSON.stringify({kind:"field",value,event})),onSubmit:(value,event)=>$.ui.status(JSON.stringify({kind:"field-submit",value,event}))}),' : '',
    'Button({key:"press",label:"Press p",hotkey:"p",onPress:event=>$.ui.status(JSON.stringify({kind:"press",event}))}),',
    '...Array.from({length:40},(_,i)=>Text({children:"author row:"+i}))]})});',
    'on("command.run",{command:"promote"},async($)=>{const result=await $.ui.open({id:"' + PANE + '",rows:5,focus:true});await $.ui.status(JSON.stringify({kind:"promoted",result}));return {}});',
    field ? 'on("command.run",{command:"refresh"},($)=>{$.ui.invalidate("ui.render");return {}});' : '',
    'on("ui.scroll",async($,e,next)=>{const result=await next(e);await $.ui.status(JSON.stringify({kind:"scroll",event:e,result}));return result});',
    'on("ui.focus",async($,e,next)=>{const result=await next(e);await $.ui.status(JSON.stringify({kind:"focus",event:e,result}));return result});',
    'on("prompt.edit",async($,e,next)=>{const result=await next(e);await $.ui.status(JSON.stringify({kind:"prompt",event:e,result}));return result});',
    '}',
  ].filter(Boolean).join('\n')
}
async function mount(initialFocus = false, field = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mods-focus-owner-')))
  const entry = join(root, 'register.ts')
  await writeFile(entry, authorSource(initialFocus, field))
  const stdin = new Input(), stdout = new Output()
  const state = getDefaultAppState(), store = createStore(state)
  const receipts: AuthorReceipt[] = [], diagnostics: ModDiagnostic[] = [], errors: unknown[] = []
  const edits: TextInputEdit[] = [], reports: string[] = []
  const presentationRef: { current: ModUiPresentation } = { current: {
    columns: stdout.columns, rows: stdout.rows, isFullscreen: false,
    composerEmpty: true, hasDialog: false, keyboardOwned: false,
  } }
  let editor: React.RefObject<PromptInputHandle | null>
  let mountedPane: ModUiPane | undefined
  let committed: { input: string; held: boolean; drawing?: number; revision?: number; owner?: ModUiPane['owner']; id?: string } | undefined
  const runtime = createModsRuntime({
    // This verifies focus ownership; the default 50ms budget is covered separately.
    promptEditBudgetMs: 1000,
    onDiagnostic: event => diagnostics.push(event),
    services: {
      uiPresentation: () => presentationRef.current,
      uiStatus: (plugin, text) => {
        if (text !== undefined) receipts.push({ plugin, value: JSON.parse(text) })
      },
    },
  })
  await runtime.bind({ cwd: root, surface: 'terminal', isInteractive: true, sessionId: 'focus-owner' })
  const declaration = { name: PLUGIN, storageId: PLUGIN + '@test', pluginRoot: root, entrypoints: [entry] }
  const queue = createModPromptEditQueue({
    read: () => ({ text: editor.current!.text, cursor: editor.current!.cursorOffset }),
    commit: box => editor.current!.setInputWithCursor(box.text, box.cursor),
    paint: (runs, text) => editor.current!.paintDecorations(runs, text),
    carry: edit => editor.current!.carryDecorations(edit),
    report: reason => reports.push(reason),
    raise: async (edit, signal) => {
      const snapshot = runtime.capture()
      try { return await runModPromptEdit(snapshot, edit, signal) }
      finally { snapshot.release() }
    },
  })
  function Host() {
    const panes = useSyncExternalStore(runtime.ui.subscribe, runtime.ui.getSnapshot)
    const [input, setInput] = useState('')
    const [mode, setMode] = useState<PromptInputMode>('prompt')
    const [pastedContents, setPastedContents] = useState<Record<number, PastedContent>>({})
    const [vimMode, setVimMode] = useState<'INSERT' | 'NORMAL'>('INSERT')
    const [helpOpen, setHelpOpen] = useState(false)
    editor = useRef(null)
    const presentation = React.useMemo<ModUiPresentation>(() => ({
      columns: stdout.columns, rows: stdout.rows, isFullscreen: false,
      composerEmpty: input.length === 0 && Object.keys(pastedContents).length === 0,
      hasDialog: false, keyboardOwned: false,
    }), [input, pastedContents])
    presentationRef.current = presentation
    React.useEffect(() => {
      // Same presentation producer as REPL; no extra invalidation or redraw barrier.
      void runtime.ui.render(presentation).catch(error => errors.push(error))
    }, [presentation])
    const current = panes.find(pane => pane.id === PANE)
    mountedPane = current
    const held = presentation.composerEmpty && !presentation.hasDialog &&
      !presentation.keyboardOwned && panes.some(pane => pane.visible && pane.shown !== false && pane.focused)
    React.useLayoutEffect(() => {
      committed = { input, held, drawing: current?.drawing, revision: current?.revision, owner: current?.owner, id: current?.id }
    })
    return <>
      {current && <ModsPane key={current.plugin + ':' + current.id}
        pane={current.focused && !held ? { ...current, focused: false } : current}
        canFocus={presentation.composerEmpty && !presentation.hasDialog && !presentation.keyboardOwned}
        onInteract={(pane, drawing, callback, kind, element, value) =>
          runtime.ui.interact(pane.id, drawing, callback, kind, element, value)}
        onClose={pane => runtime.ui.close(pane.owner, pane.id, { kind: 'person' })}
        onFocus={async (pane, element) => {
          const result = await runtime.ui.focus(pane.owner, {
            requestId: pane.id, element, origin: { kind: 'person' },
          }, presentationRef.current)
          const landing = runtime.ui.getSnapshot().find(next => next.id === pane.id && next.owner === pane.owner)
          return { ...(result as Record<string, unknown>), ...(landing ? { revision: landing.revision } : { focused: false }) }
        }}
        onScroll={(pane, by, pointer) => runtime.ui.scroll(pane.owner, {
          requestId: pane.id, by, pointer, origin: { kind: 'person' },
        })}
        onReportMetrics={(pane, metrics) => {
          if (metrics.keyRows === undefined && metrics.bodyRows === pane.bodyRows &&
              metrics.contentRows === pane.contentRows) return
          return runtime.ui.reportMetrics(pane.id, metrics)
        }}
        onError={error => errors.push(error)}
      />}
      <PromptInput debug={false} ideSelection={undefined}
        toolPermissionContext={state.toolPermissionContext} setToolPermissionContext={() => {}}
        apiKeyStatus="valid" commands={[]} agents={[]} enableLocalIOCompletions={false}
        isLoading={false} isAssistantResponding={false} verbose={false} messages={[]}
        onAutoUpdaterResult={() => {}} autoUpdaterResult={null} input={input} onInputChange={setInput}
        onPromptEdit={edit => { edits.push(structuredClone(edit)); queue?.record(edit) }}
        mode={mode} onModeChange={setMode} stashedPrompt={undefined} setStashedPrompt={() => {}}
        submitCount={0} onShowMessageSelector={() => {}} mcpClients={[]}
        pastedContents={pastedContents} setPastedContents={setPastedContents}
        vimMode={vimMode} setVimMode={setVimMode} showBashesDialog={false} setShowBashesDialog={() => {}}
        onExit={() => {}} getToolUseContext={() => { throw new Error('No query in UI1 source test') }}
        onSubmit={async () => { throw new Error('No submit in UI1 source test') }}
        isSearchingHistory={false} setIsSearchingHistory={() => {}}
        helpOpen={helpOpen} setHelpOpen={setHelpOpen}
        isLocalJSXCommandActive={held} insertTextRef={editor}
      />
    </>
  }
  const instance = await render(<AppStoreContext value={store}><ThemeProvider initialState="dark"><Host /></ThemeProvider></AppStoreContext>, {
    stdin: stdin as never, stdout: stdout as never, patchConsole: false, exitOnCtrlC: false,
  })

  function inkRoot() {
    return (instances.get(stdout as never) as unknown as { rootNode: DOMElement }).rootNode
  }
  function paneRoot() {
    const label = findText(inkRoot(), '[ Press p ]')
    for (let current = label; current; current = current.parentNode) {
      if (typeof current._eventHandlers?.onKeyDown === 'function' &&
          typeof current._eventHandlers?.onFocusCapture === 'function') return current
    }
    return undefined
  }
  function evidence() {
    const dom = paneRoot(), current = runtime.ui.getSnapshot().find(pane => pane.id === PANE)
    return { box: editor.current && { text: editor.current.text, cursor: editor.current.cursorOffset },
      pane: current && { id: current.id, plugin: current.plugin, focused: current.focused,
        focusedElement: current.focusedElement, drawing: current.drawing, revision: current.revision,
        scrollOffset: current.scrollOffset, bodyRows: current.bodyRows, contentRows: current.contentRows },
      dom: dom && { autoFocus: dom.attributes.autoFocus, tabIndex: dom.attributes.tabIndex,
        ownsDomTarget: isWithin(getFocusManager(dom).activeElement, dom) },
      committed: committed && { ...committed, owner: committed.owner === current?.owner },
      receipts, diagnostics, reports, errors: errors.map(String), edits }
  }
  async function promote() {
    return runtime.dispatch('command.run', {
      command: 'promote', args: '', origin: { kind: 'composer' },
      presentation: { columns: stdout.columns, isFullscreen: false },
    }, async () => ({}))
  }
  async function refresh() {
    return runtime.dispatch('command.run', {
      command: 'refresh', args: '', origin: { kind: 'composer' },
      presentation: { columns: stdout.columns, isFullscreen: false },
    }, async () => ({}))
  }
  try {
    await runtime.reconcile([declaration])
    await waitFor(() => Boolean(editor.current && paneRoot() &&
      mountedPane?.drawing && mountedPane.contentRows > mountedPane.bodyRows),
    'initial actual consumer and natural scroll metrics', evidence)
  } catch (error) {
    queue.dispose(); instance.unmount(); instance.cleanup()
    await runtime.dispose(); await rm(root, { recursive: true, force: true })
    throw error
  }
  return { stdin, runtime, receipts, diagnostics, reports, errors, edits, promote, refresh, paneRoot, evidence,
    get editor() { return editor.current! },
    get committed() { return committed },
    get pane() { return runtime.ui.getSnapshot().find(pane => pane.id === PANE) },
    get inkRoot() { return inkRoot() },
    async dispose() {
      queue!.dispose(); instance.unmount(); instance.cleanup()
      await runtime.dispose(); await rm(root, { recursive: true, force: true })
    },
  }
}

test('UI1 actual author promotes an already mounted body without autoFocus and owns PageDown plus p', async () => {
  const h = await mount()
  try {
    const firstRoot = h.paneRoot()!, firstOwner = h.pane!.owner
    expect(h.pane).toMatchObject({ id: PANE, plugin: PLUGIN, visible: true, focused: false })
    expect(firstRoot.attributes.autoFocus).toBe(false)
    h.stdin.push('q')
    await waitFor(() => h.editor.text === 'q' && h.committed?.input === 'q' && h.receipts.some(receipt => receipt.value.kind === 'prompt'),
      'actual composer before promotion', h.evidence)
    expect(h.edits).toEqual([{ before: { text: '', cursor: 0 }, after: { text: 'q', cursor: 1 }, key: { key: 'q' } }])
    expect(h.receipts.find(receipt => receipt.value.kind === 'prompt')).toEqual({
      plugin: PLUGIN, value: { kind: 'prompt', event: {
        text: '', cursor: 0, start: 0, end: 0, inputText: 'q', key: { key: 'q' }, origin: { kind: 'composer' },
      }, result: { text: 'q', cursor: 1 } },
    })
    h.editor.setInputWithCursor('', 0)
    await waitFor(() => h.editor.text === '' && h.committed?.input === '' && h.pane?.focused === false && h.paneRoot() === firstRoot,
      'application clear committed before promotion', h.evidence)
    const beforeDrawing = h.pane!.drawing
    await h.promote()
    await waitFor(() => h.pane?.focused === true && h.pane.drawing !== beforeDrawing &&
      h.paneRoot() === firstRoot && h.committed?.drawing === h.pane.drawing && h.committed?.held === true && firstRoot.attributes.tabIndex === 0 &&
      firstRoot.attributes.autoFocus === true,
    'actual focused drawing committed on the same pane root', h.evidence)
    expect(h.pane!.owner).toBe(firstOwner)
    expect(h.pane!.id).toBe(PANE)
    expect(h.pane!.focusedElement).toBeUndefined()
    expect(h.receipts.filter(receipt => receipt.value.kind === 'promoted')).toEqual([
      { plugin: PLUGIN, value: { kind: 'promoted', result: { isPlaced: true } } },
    ])
    expect(h.receipts.filter(receipt => receipt.value.kind === 'focus')).toEqual([])
    const before = h.pane!, previousReceipts = h.receipts.length
    const expectedOffset = Math.min(before.bodyRows, before.contentRows - before.bodyRows)
    expect(expectedOffset).toBeGreaterThan(0)
    // Raw same-read semantic PageDown and printable hotkey through the actual parser/App.
    h.stdin.push('\x1b[6~p')
    await waitFor(() => h.pane?.scrollOffset === expectedOffset &&
      h.receipts.slice(previousReceipts).some(receipt => receipt.value.kind === 'scroll') &&
      h.receipts.slice(previousReceipts).some(receipt => receipt.value.kind === 'press'),
    'held pane receives PageDown scroll and p author receipts', h.evidence)
    const received = h.receipts.slice(previousReceipts)
    expect(received.filter(receipt => receipt.value.kind === 'scroll')).toEqual([{
      plugin: PLUGIN, value: { kind: 'scroll', event: {
        component: 'Pane', requestId: PANE, offset: expectedOffset, by: before.bodyRows,
        bodyRows: before.bodyRows, contentRows: before.contentRows, origin: { kind: 'person' },
      }, result: {} },
    }])
    expect(received.filter(receipt => receipt.value.kind === 'press')).toEqual([{
      plugin: PLUGIN, value: { kind: 'press', event: {
        plugin: PLUGIN, element: 'press', component: 'Pane', requestId: PANE, surface: 'terminal',
      } },
    }])
    expect({ text: h.editor.text, cursor: h.editor.cursorOffset, edits: h.edits.length }).toEqual({
      text: '', cursor: 0, edits: 1,
    })
    expect(h.pane!.owner).toBe(firstOwner)
    expect(h.paneRoot()).toBe(firstRoot)
    expect(isWithin(getFocusManager(firstRoot).activeElement, firstRoot)).toBe(true)
    expect({ diagnostics: h.diagnostics, reports: h.reports, errors: h.errors }).toEqual({
      diagnostics: [], reports: [], errors: [],
    })
  } finally { await h.dispose() }
})

test('UI1 ordinary redraw retains an already held real author Input descendant and its typed value', async () => {
  const h = await mount(true, true)
  try {
    await waitFor(() => h.pane?.focusedElement === 'field', 'actual autofocus field receipt', h.evidence)
    await waitFor(() => {
      const published = h.pane
      return Boolean(published && h.committed?.owner === published.owner && h.committed.id === published.id &&
        h.committed.drawing === published.drawing && h.committed.revision === published.revision)
    }, 'actual same owner focus revision committed by the consumer', h.evidence)
    const root = h.paneRoot()!, manager = getFocusManager(root), field = manager.activeElement
    expect(field).not.toBe(root)
    expect(isWithin(field, root)).toBe(true)
    h.stdin.push('u')
    await waitFor(() => h.receipts.some(receipt => receipt.value.kind === 'field' && receipt.value.value === 'u'),
      'actual first field input', h.evidence)
    const before = h.pane!
    await h.refresh()
    await waitFor(() => h.pane?.drawing !== before.drawing && h.pane?.focusedElement === 'field' &&
      h.committed?.drawing === h.pane?.drawing && h.committed?.held === true,
      'actual same owner redraw publication', h.evidence)
    expect(h.pane!.owner).toBe(before.owner)
    expect(h.paneRoot()).toBe(root)
    expect(manager.activeElement).toBe(field)
    h.stdin.push('v')
    await waitFor(() => h.receipts.some(receipt => receipt.value.kind === 'field' && receipt.value.value === 'uv'),
      'descendant retains its text after redraw', h.evidence)
    expect(h.receipts.filter(receipt => receipt.value.kind === 'field').map(receipt => receipt.value.value)).toEqual(['u', 'uv'])
    expect({ text: h.editor.text, cursor: h.editor.cursorOffset, edits: h.edits }).toEqual({ text: '', cursor: 0, edits: [] })
    expect({ diagnostics: h.diagnostics, reports: h.reports, errors: h.errors }).toEqual({
      diagnostics: [], reports: [], errors: [],
    })
  } finally { await h.dispose() }
})

test('UI1 actual unload revokes the old held drawing while a retained runtime lease cannot steal composer keys', async () => {
  const h = await mount(true)
  const lease = h.runtime.capture()
  try {
    const old = h.pane!, oldRoot = h.paneRoot()!, callback = callbackOf(old.tree, 'press')
    expect(isWithin(getFocusManager(oldRoot).activeElement, oldRoot)).toBe(true)
    expect(callback).toBeDefined()
    await h.runtime.reconcile([])
    await waitFor(() => h.pane === undefined && h.paneRoot() === undefined,
      'actual unload committed to the mounted consumer', h.evidence)
    await expect(h.runtime.ui.interact(old.id, old.drawing!, callback!, 'press', 'press')).rejects.toThrow(/stale/)
    const count = h.receipts.length
    h.stdin.push('k')
    await waitFor(() => h.editor.text === 'k' && h.edits.length === 1, 'composer after actual unload', h.evidence)
    expect(h.receipts.slice(count).some(receipt => receipt.value.kind === 'press')).toBe(false)
    expect(h.edits).toEqual([{ before: { text: '', cursor: 0 }, after: { text: 'k', cursor: 1 }, key: { key: 'k' } }])
    expect(h.runtime.ui.getSnapshot()).toEqual([])
    expect(isWithin(getFocusManager(h.inkRoot).activeElement, oldRoot)).toBe(false)
    expect({ diagnostics: h.diagnostics, reports: h.reports, errors: h.errors }).toEqual({
      diagnostics: [], reports: [], errors: [],
    })
  } finally { lease.release(); await h.dispose() }
})
