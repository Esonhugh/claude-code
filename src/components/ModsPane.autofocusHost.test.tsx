import { resetSettingsCache } from '../utils/settings/settingsCache.js'
import { beforeEach, afterEach, expect, test } from 'bun:test'
import React, { useRef, useState, useSyncExternalStore } from 'react'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import ts from 'typescript'
import { ThemeProvider, render } from '../ink.js'
import instances from '../ink/instances.js'
import type { DOMElement, DOMNode } from '../ink/dom.js'
import type { InputEvent } from '../ink/events/input-event.js'
import { getFocusManager } from '../ink/focus.js'
import useStdin from '../ink/hooks/use-stdin.js'
import { AppStoreContext, getDefaultAppState } from '../state/AppState.js'
import { createStore } from '../state/store.js'
import type { PastedContent } from '../utils/config.js'
import type { PromptInputMode, TextInputEdit, VimMode } from '../types/textInputTypes.js'
import { createModsRuntime, type ModDiagnostic } from '../services/mods/runtime.js'
import type { ModUiPane, ModUiPresentation } from '../services/mods/ui.js'
import { withModUiHostFocusOutcome } from '../services/mods/ui.js'
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

const PLUGIN = 'af-owner'
const OBSERVER = 'af-observer'
const PANE = 'af-panel'
type Kind = 'Input' | 'Button' | 'Select'
type EditorHandle = NonNullable<NonNullable<React.ComponentProps<typeof PromptInput>['insertTextRef']>['current']>
type Policy = 'accept' | 'deny' | 'withhold' | 'rewrite-valid' | 'rewrite-unknown' | 'public-nested'
type AuthorReceipt = { plugin: string; value: Record<string, unknown> }
type Checkpoint = {
  draws: number
  focusCalls: number
  changes: { element: string; value: string }[]
  actions: { element: string; value?: string }[]
}
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
async function waitFor(done: () => boolean, phase: string, evidence: () => unknown) {
  const deadline = Date.now() + 1000
  while (!done() && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
  if (!done()) console.error('UI1 autofocus host barrier:', JSON.stringify({ phase, evidence: evidence() }))
  expect(done()).toBe(true)
}
function textOf(node: DOMNode): string {
  return node.nodeName === '#text' ? node.nodeValue : node.childNodes.map(textOf).join('')
}
function findText(root: DOMElement, text: string): DOMElement | undefined {
  if ((root.nodeName === 'ink-text' || root.nodeName === 'ink-virtual-text') && textOf(root) === text) return root
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

// Use the actual unique REPL callback, without importing REPL's startup graph.
function makeREPLOnFocus(scope: Record<string, unknown>): React.ComponentProps<typeof ModsPane>['onFocus'] {
  const source = readFileSync(new URL('../screens/REPL.tsx', import.meta.url), 'utf8')
  const file = ts.createSourceFile('REPL.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const renderers: ts.ArrowFunction[] = []
  function findRenderer(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'renderModPane' &&
        node.initializer && ts.isArrowFunction(node.initializer)) renderers.push(node.initializer)
    ts.forEachChild(node, findRenderer)
  }
  findRenderer(file)
  expect(renderers).toHaveLength(1)
  const callbacks: ts.Expression[] = []
  function findCallback(node: ts.Node) {
    if (ts.isJsxAttribute(node) && node.name.getText(file) === 'onFocus' &&
        node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression)
      callbacks.push(node.initializer.expression)
    ts.forEachChild(node, findCallback)
  }
  findCallback(renderers[0]!)
  expect(callbacks).toHaveLength(1)
  const javascript = ts.transpileModule(`const extracted = (${callbacks[0]!.getText(file)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React },
  }).outputText
  return new Function('scope', `with (scope) { ${javascript}; return extracted; }`)({ withModUiHostFocusOutcome, ...scope })
}

function authorSource(kind: Kind, policy: Policy) {
  const autofocus = policy !== 'public-nested'
  const control = (element: 'first' | 'second') => {
    const title = element === 'first' ? 'First' : 'Second'
    const common = `key:${JSON.stringify(element)}${autofocus ? ',autoFocus:true' : ''}`
    if (kind === 'Input') return `Input({${common},label:${JSON.stringify(title + ' input')},placeholder:${JSON.stringify(title + ' empty')},
      onInput:(value,event)=>{changes.push({element:${JSON.stringify(element)},value});$.ui.status(JSON.stringify({kind:'input',element:${JSON.stringify(element)},value,event}))},
      onSubmit:(value,event)=>{actions.push({element:${JSON.stringify(element)},value});$.ui.status(JSON.stringify({kind:'action',element:${JSON.stringify(element)},value,event}))}})`
    if (kind === 'Select') return `Select({${common},label:${JSON.stringify(title + ' select')},value:'one',options:[{value:'one',label:'One'},{value:'two',label:'Two'}],
      onSelect:(value,event)=>{actions.push({element:${JSON.stringify(element)},value});$.ui.status(JSON.stringify({kind:'action',element:${JSON.stringify(element)},value,event}))}})`
    return `Button({${common},label:${JSON.stringify(title + ' button')},onPress:event=>{actions.push({element:${JSON.stringify(element)}});$.ui.status(JSON.stringify({kind:'action',element:${JSON.stringify(element)},event}))}})`
  }
  const focus = policy === 'deny' ? `const result={deny:'AF held'};`
    : policy === 'withhold' ? `const result={};`
    : policy === 'rewrite-valid' ? `const result=await next({element:'second'});`
    : policy === 'rewrite-unknown' ? `const result=await next({element:'missing'});`
    : policy === 'public-nested' ? `
      if(e.origin.kind==='plugin'&&e.element==='first') {
        const result=await $.ui.focus({requestId:${JSON.stringify(PANE)},key:'second'});
        $.ui.status(JSON.stringify({kind:'nested-public',result}));
        return {};
      }
      const result=await next(e);`
    : `const result=await next(e);`
  return `let draws=0,focusCalls=0;const changes=[],actions=[];
    export function register(on) {
      on('session.start',async($,e,next)=>{await $.ui.open({id:${JSON.stringify(PANE)},rows:6,focus:true});return next(e)});
      on('ui.render',{component:'Pane'},($,e)=>{const {Box,Text,Input,Button,Select}=$.ui.resolve(e);draws++;return Box({flexDirection:'column',children:[
        Text({children:'AF author surface'}),${control('first')},${control('second')},Text({children:'AF body tail'})]})});
      on('ui.focus',async($,e,next)=>{
        focusCalls++;$.ui.status(JSON.stringify({kind:'focus-enter',event:e,call:focusCalls,caller:next.origin}));
        ${focus}
        $.ui.status(JSON.stringify({kind:'focus-result',event:e,result}));return result;
      });
      on('command.run',{command:'af-checkpoint'},()=>({text:JSON.stringify({draws,focusCalls,changes,actions})}));
      on('command.run',{command:'af-public'},async($)=>{
        const result=await $.ui.focus({requestId:${JSON.stringify(PANE)},key:'first'});
        $.ui.status(JSON.stringify({kind:'public',result}));return {};
      });
      on('prompt.edit',async($,e,next)=>{const result=await next(e);$.ui.status(JSON.stringify({kind:'prompt',event:e,result}));return result});
    }`
}

async function mount(kind: Kind, policy: Policy) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'mods-autofocus-host-')))
  const entry = join(directory, 'register.ts')
  try { await writeFile(entry, authorSource(kind, policy)) }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
  const stdin = new Input(), stdout = new Output()
  const state = getDefaultAppState(), store = createStore(state)
  const receipts: AuthorReceipt[] = [], diagnostics: ModDiagnostic[] = [], errors: unknown[] = []
  const edits: TextInputEdit[] = []
  const checkpoints: Checkpoint[] = []
  const semantics: { input: string; key: InputEvent['key'] }[] = []
  let completedSemanticJobs = 0
  let observerReady = false
  const pendingMetricRedraws = new Set<Promise<void>>()
  const presentationRef: { current: ModUiPresentation } = { current: {
    columns: stdout.columns, rows: stdout.rows, isFullscreen: false,
    composerEmpty: true, hasDialog: false, keyboardOwned: false,
  } }
  let editor: React.RefObject<EditorHandle | null>
  let mountedPane: ModUiPane | undefined
  let committed: { input: string; held: boolean; drawing?: number; revision?: number; owner?: ModUiPane['owner']; id?: string } | undefined
  const runtime = createModsRuntime({
    onDiagnostic: event => diagnostics.push(event),
    services: {
      uiPresentation: () => presentationRef.current,
      uiStatus: (plugin, text) => {
        if (text !== undefined) receipts.push({ plugin, value: JSON.parse(text) })
      },
    },
  })
  let onFocus: React.ComponentProps<typeof ModsPane>['onFocus']
  let instance: Awaited<ReturnType<typeof render>> | undefined
  let observeInput: (() => void) | undefined
  function ObserveInput() {
    const { internal_eventEmitter } = useStdin()
    React.useLayoutEffect(() => {
      const observe = (event: InputEvent) => {
        semantics.push({ input: event.input, key: { ...event.key } })
        queueMicrotask(() => { completedSemanticJobs++ })
      }
      observeInput = () => {
        internal_eventEmitter.removeListener('input', observe)
        internal_eventEmitter.prependListener('input', observe)
      }
      observeInput()
      observerReady = true
      return () => { observerReady = false; internal_eventEmitter.removeListener('input', observe) }
    }, [internal_eventEmitter])
    return null
  }
  function Host() {
    const panes = useSyncExternalStore(runtime.ui.subscribe, runtime.ui.getSnapshot)
    const [input, setInput] = useState('')
    const [mode, setMode] = useState<PromptInputMode>('prompt')
    const [pastedContents, setPastedContents] = useState<Record<number, PastedContent>>({})
    const [vimMode, setVimMode] = useState<VimMode>('INSERT')
    const [helpOpen, setHelpOpen] = useState(false)
    editor = useRef(null)
    const presentation = React.useMemo<ModUiPresentation>(() => ({
      columns: stdout.columns, rows: stdout.rows, isFullscreen: false,
      composerEmpty: input.length === 0 && Object.keys(pastedContents).length === 0,
      hasDialog: false, keyboardOwned: false,
    }), [input, pastedContents])
    presentationRef.current = presentation
    React.useEffect(() => {
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
      <ObserveInput />
      {current && <ModsPane key={current.plugin + ':' + current.id}
        pane={current.focused && !held ? { ...current, focused: false } : current}
        canFocus={presentation.composerEmpty && !presentation.hasDialog && !presentation.keyboardOwned &&
          !panes.some(other => other.visible && other.shown !== false && other.focused && other.id !== current.id)}
        onInteract={(pane, drawing, callback, interaction, element, value) =>
          runtime.ui.interact(pane.id, drawing, callback, interaction, element, value)}
        onClose={pane => runtime.ui.close(pane.owner, pane.id, { kind: 'person' })}
        onFocus={onFocus}
        onScroll={(pane, by, pointer) => runtime.ui.scroll(pane.owner, {
          requestId: pane.id, by, pointer, origin: { kind: 'person' },
        })}
        onReportMetrics={(pane, metrics) => {
          if (metrics.keyRows === undefined && metrics.bodyRows === pane.bodyRows &&
              metrics.contentRows === pane.contentRows) return
          const redraw = runtime.ui.reportMetrics(pane.id, metrics)
          if (redraw) {
            pendingMetricRedraws.add(redraw)
            void redraw.then(() => { pendingMetricRedraws.delete(redraw) }, () => { pendingMetricRedraws.delete(redraw) })
          }
          return redraw
        }}
        onError={error => errors.push(error)}
      />}
      <PromptInput {...{ onPromptEdit: (edit: TextInputEdit) => { edits.push(structuredClone(edit)) } }}
        debug={false} ideSelection={undefined}
        toolPermissionContext={state.toolPermissionContext} setToolPermissionContext={() => {}}
        apiKeyStatus="valid" commands={[]} agents={[]} enableLocalIOCompletions={false}
        isLoading={false} isAssistantResponding={false} verbose={false} messages={[]}
        onAutoUpdaterResult={() => {}} autoUpdaterResult={null} input={input} onInputChange={setInput}
        mode={mode} onModeChange={setMode} stashedPrompt={undefined} setStashedPrompt={() => {}}
        submitCount={0} onShowMessageSelector={() => {}} mcpClients={[]}
        pastedContents={pastedContents} setPastedContents={setPastedContents}
        vimMode={vimMode} setVimMode={setVimMode} showBashesDialog={false} setShowBashesDialog={() => {}}
        onExit={() => {}} getToolUseContext={() => { throw new Error('No query in AF source test') }}
        onSubmit={async () => { throw new Error('No submit in AF source test') }}
        isSearchingHistory={false} setIsSearchingHistory={() => {}}
        helpOpen={helpOpen} setHelpOpen={setHelpOpen}
        isLocalJSXCommandActive={held} insertTextRef={editor}
      />
    </>
  }
  function inkRoot() {
    return (instances.get(stdout as never) as unknown as { rootNode: DOMElement }).rootNode
  }
  function paneRoot() {
    const label = findText(inkRoot(), 'AF author surface')
    for (let current = label; current; current = current.parentNode) {
      if (typeof current._eventHandlers?.onKeyDown === 'function') return current
    }
    return undefined
  }
  function elementFor(key: 'first' | 'second') {
    const root = paneRoot()
    if (!root) return undefined
    const title = key === 'first' ? 'First' : 'Second'
    const label = kind === 'Button' ? `[ ${title} button ]` : `${title} ${kind === 'Input' ? 'input' : 'select'}: `
    for (let node = findText(root, label); node && node !== root; node = node.parentNode) {
      if (typeof node.attributes.tabIndex === 'number') return node
    }
    return undefined
  }
  function evidence() {
    const root = paneRoot(), pane = runtime.ui.getSnapshot().find(current => current.id === PANE)
    const target = root && getFocusManager(root).activeElement
    return {
      policy, kind, box: editor?.current && { text: committed?.input, cursor: editor.current.cursorOffset },
      pane: pane && { id: pane.id, plugin: pane.plugin, focused: pane.focused,
        focusedElement: pane.focusedElement, drawing: pane.drawing, revision: pane.revision,
        bodyRows: pane.bodyRows, contentRows: pane.contentRows },
      dom: root && { text: textOf(root), active: target === elementFor('first') ? 'first'
        : target === elementFor('second') ? 'second' : target === root ? 'body' : 'other',
      heldInside: isWithin(target ?? null, root), height: root.yogaNode?.getComputedHeight() },
      committed: committed && { ...committed, owner: committed.owner === pane?.owner }, pendingMetricRedraws: pendingMetricRedraws.size,
      semantics, completedSemanticJobs, checkpoints, receipts, edits, diagnostics, errors: errors.map(String),
    }
  }
  function command(command: string) {
    return runtime.dispatch('command.run', {
      command, args: '', origin: { kind: 'composer' },
      presentation: { columns: stdout.columns, isFullscreen: false },
    }, async () => ({}))
  }
  async function checkpoint(): Promise<Checkpoint> {
    const result = await command('af-checkpoint') as { text?: string }
    expect(typeof result.text).toBe('string')
    const value = JSON.parse(result.text!) as Checkpoint
    checkpoints.push(structuredClone(value))
    return value
  }
  async function raw(input: string, semanticCount: number) {
    const count = semantics.length
    // A newly mounted Pane prepends its consumer after this persistent probe.
    // Observe the parser event before consumption, without changing its handling.
    observeInput!()
    stdin.push(input)
    await waitFor(() => semantics.length === count + semanticCount &&
      completedSemanticJobs === semantics.length, 'actual parser semantic dispatch has returned', evidence)
    // No draw/focus call: wait for real queued Worker operations, then ask the
    // same live author closure for its counts through command.run.
    await runtime.settle()
    const result = await checkpoint()
    await runtime.settle()
    return result
  }
  async function dispose() {
    instance?.unmount()
    instance?.cleanup()
    try { await runtime.dispose() }
    finally { stdin.destroy(); stdout.destroy(); await rm(directory, { recursive: true, force: true }) }
  }
  try {
    onFocus = makeREPLOnFocus({ modsSession: { runtime }, modUiPresentationRef: presentationRef })
    await runtime.bind({ cwd: directory, surface: 'terminal', isInteractive: true, sessionId: 'af-host' })
    instance = await render(<AppStoreContext value={store}><ThemeProvider initialState="dark"><Host /></ThemeProvider></AppStoreContext>, {
      stdin: stdin as never, stdout: stdout as never, patchConsole: false, exitOnCtrlC: false,
    })
    const owner = { name: PLUGIN, storageId: PLUGIN + '@test', pluginRoot: directory, entrypoints: [entry] }
    if (policy === 'public-nested') {
      const observerEntry = join(directory, 'observer.ts')
      await writeFile(observerEntry, `export function register(on) {
        on('ui.focus',async($,e,next)=>{const result=await next(e);$.ui.status(JSON.stringify({kind:'observed-focus',event:e,result,caller:next.origin}));return result});
      }`)
      await runtime.reconcile([{ name: OBSERVER, storageId: OBSERVER + '@test', pluginRoot: directory, entrypoints: [observerEntry] }, owner])
    } else await runtime.reconcile([owner])
    await waitFor(() => {
      const published = runtime.ui.getSnapshot().find(current => current.id === PANE)
      return Boolean(observerReady && editor.current && paneRoot() && elementFor('first') && elementFor('second') &&
        pendingMetricRedraws.size === 0 && published?.drawing && published.bodyRows > 0 && published.contentRows >= 3 &&
        mountedPane?.owner === published.owner && mountedPane.id === published.id &&
        committed?.held && committed.owner === published.owner && committed.id === published.id &&
        committed.drawing === published.drawing && committed.revision === published.revision &&
        paneRoot()!.yogaNode!.getComputedHeight() > 0)
    }, 'actual author tree, settled metrics redraw and current held consumer commit', evidence)
  } catch (error) { await dispose(); throw error }
  return {
    runtime, receipts, edits, diagnostics, errors, semantics, raw, checkpoint, command, evidence, paneRoot, elementFor, dispose,
    get pane() { return runtime.ui.getSnapshot().find(current => current.id === PANE) },
    get editor() { return editor.current! },
    get committed() { return committed },
  }
}

function focusEvent(element: string) {
  return { component: 'Pane', requestId: PANE, plugin: PLUGIN, element, origin: { kind: 'plugin', name: PLUGIN } }
}
function values(receipts: AuthorReceipt[], kind: string, plugin = PLUGIN) {
  return receipts.filter(receipt => receipt.plugin === plugin && receipt.value.kind === kind).map(receipt => receipt.value)
}
function clean(h: Awaited<ReturnType<typeof mount>>) {
  expect({ text: h.committed!.input, cursor: h.editor.cursorOffset, edits: h.edits }).toEqual({ text: '', cursor: 0, edits: [] })
  expect({ diagnostics: h.diagnostics, errors: h.errors }).toEqual({ diagnostics: [], errors: [] })
}

for (const kind of ['Input', 'Button', 'Select'] as const) {
  test(`AF01 ${kind} first drawn negotiation is observable by its own Worker and lands the first control`, async () => {
    const h = await mount(kind, 'accept')
    try {
      const root = h.paneRoot()!, owner = h.pane!.owner, drawing = h.pane!.drawing
      expect(h.pane).toMatchObject({ id: PANE, plugin: PLUGIN, visible: true, focused: true })
      await waitFor(() => values(h.receipts, 'focus-result').length === 1 && h.pane?.focusedElement === 'first' &&
        h.committed?.revision === h.pane.revision && getFocusManager(root).activeElement === h.elementFor('first'),
      'first drawn accepted self-hook and actual committed landing', h.evidence)
      expect(values(h.receipts, 'focus-enter')).toEqual([{ kind: 'focus-enter', event: focusEvent('first'), call: 1, caller: { plugin: 'engine', tier: 'core' } }])
      expect(values(h.receipts, 'focus-result')).toEqual([{ kind: 'focus-result', event: focusEvent('first'), result: {} }])
      expect(h.pane!.owner).toBe(owner)
      expect(h.paneRoot()).toBe(root)
      expect(h.pane!.drawing).toBe(drawing)
      const result = await h.raw(kind === 'Input' ? 'u\r' : '\r', kind === 'Input' ? 2 : 1)
      expect(result.focusCalls).toBe(1)
      expect(result.changes).toEqual(kind === 'Input' ? [{ element: 'first', value: 'u' }] : [])
      expect(result.actions).toEqual([{ element: 'first', ...(kind === 'Input' ? { value: 'u' } : kind === 'Select' ? { value: 'one' } : {}) }])
      expect(values(h.receipts, 'action')).toHaveLength(1)
      expect(values(h.receipts, 'action')[0]).toMatchObject({ element: 'first', event: { plugin: PLUGIN, element: 'first', requestId: PANE, component: 'Pane' } })
      if (kind === 'Input') expect(textOf(h.elementFor('first')!)).toContain('u')
      expect(h.pane!.owner).toBe(owner)
      expect(h.paneRoot()).toBe(root)
      expect(getFocusManager(root).activeElement).toBe(h.elementFor('first')!)
      clean(h)
    } finally { await h.dispose() }
  })
}

for (const policy of ['deny', 'withhold'] as const) {
  test(`AF${policy === 'deny' ? '02' : '03'} ${policy} negotiates without granting the native Input or fabricating a landing`, async () => {
    const h = await mount('Input', policy)
    try {
      const root = h.paneRoot()!, owner = h.pane!.owner
      // Deliberately do not await a successful focusedElement before raw input.
      const result = await h.raw('u', 1)
      await waitFor(() => values(h.receipts, 'focus-result').length === 1, 'own automatic refusal/withhold receipt', h.evidence)
      expect(values(h.receipts, 'focus-enter')).toEqual([{ kind: 'focus-enter', event: focusEvent('first'), call: 1, caller: { plugin: 'engine', tier: 'core' } }])
      expect(values(h.receipts, 'focus-result')).toEqual([{ kind: 'focus-result', event: focusEvent('first'), result: policy === 'deny' ? { deny: 'AF held' } : {} }])
      expect(result.changes).toEqual([])
      expect(result.actions).toEqual([])
      expect(values(h.receipts, 'input')).toEqual([])
      expect(values(h.receipts, 'action')).toEqual([])
      expect(h.pane!.focusedElement).toBeUndefined()
      expect(getFocusManager(root).activeElement).not.toBe(h.elementFor('first')!)
      expect(getFocusManager(root).activeElement).not.toBe(h.elementFor('second')!)
      expect(textOf(h.elementFor('first')!)).toContain('First empty')
      expect(textOf(h.elementFor('second')!)).toContain('Second empty')
      expect(h.pane!.owner).toBe(owner)
      expect(h.paneRoot()).toBe(root)
      clean(h)
    } finally { await h.dispose() }
  })
}

test('AF04 valid same-site rewrite restores pinned fields and lands the second real drawn control', async () => {
  const h = await mount('Button', 'rewrite-valid')
  try {
    const root = h.paneRoot()!, owner = h.pane!.owner
    await waitFor(() => values(h.receipts, 'focus-result').length === 1 && h.pane?.focusedElement === 'second' &&
      h.committed?.revision === h.pane.revision && getFocusManager(root).activeElement === h.elementFor('second'),
    'actual rewritten second control publication and DOM landing', h.evidence)
    expect(values(h.receipts, 'focus-enter')).toEqual([{ kind: 'focus-enter', event: focusEvent('first'), call: 1, caller: { plugin: 'engine', tier: 'core' } }])
    expect(values(h.receipts, 'focus-result')).toEqual([{ kind: 'focus-result', event: focusEvent('first'), result: {} }])
    const result = await h.raw('\r', 1)
    expect(result.focusCalls).toBe(1)
    expect(result.changes).toEqual([])
    expect(result.actions).toEqual([{ element: 'second' }])
    expect(values(h.receipts, 'action')).toHaveLength(1)
    expect(values(h.receipts, 'action')[0]).toMatchObject({ element: 'second', event: { plugin: PLUGIN, element: 'second', requestId: PANE, component: 'Pane' } })
    expect(h.pane!.owner).toBe(owner)
    expect(h.paneRoot()).toBe(root)
    clean(h)
  } finally { await h.dispose() }
})

test('AF04 unknown same-site rewrite retains the actual stop and cannot activate either drawn button', async () => {
  const h = await mount('Button', 'rewrite-unknown')
  try {
    const root = h.paneRoot()!, owner = h.pane!.owner
    await waitFor(() => values(h.receipts, 'focus-result').length === 1, 'own unknown rewrite has settled', h.evidence)
    expect(values(h.receipts, 'focus-enter')).toEqual([{ kind: 'focus-enter', event: focusEvent('first'), call: 1, caller: { plugin: 'engine', tier: 'core' } }])
    expect(values(h.receipts, 'focus-result')[0]).toMatchObject({ kind: 'focus-result', event: focusEvent('first'), result: { deny: expect.any(String) } })
    const result = await h.raw('\r', 1)
    expect(result.focusCalls).toBe(1)
    expect(result.actions).toEqual([])
    expect(values(h.receipts, 'action')).toEqual([])
    expect(h.pane!.focusedElement).toBeUndefined()
    expect(getFocusManager(root).activeElement).not.toBe(h.elementFor('first')!)
    expect(getFocusManager(root).activeElement).not.toBe(h.elementFor('second')!)
    expect(h.pane!.owner).toBe(owner)
    expect(h.paneRoot()).toBe(root)
    clean(h)
  } finally { await h.dispose() }
})

test('AF12 public author focus permits its sibling hook while nested focus excludes that live registration only', async () => {
  const h = await mount('Button', 'public-nested')
  try {
    const root = h.paneRoot()!, owner = h.pane!.owner
    expect(h.elementFor('first')!.attributes.autoFocus).toBe(false)
    expect(h.elementFor('second')!.attributes.autoFocus).toBe(false)
    const before = values(h.receipts, 'focus-enter').length
    expect(await h.command('af-public')).toEqual({})
    await h.runtime.settle()
    await waitFor(() => values(h.receipts, 'public').length === 1 && values(h.receipts, 'nested-public').length === 1 &&
      h.pane?.focusedElement === 'second' && h.committed?.revision === h.pane.revision &&
      getFocusManager(root).activeElement === h.elementFor('second'), 'public nested operation and committed landing', h.evidence)
    expect(values(h.receipts, 'focus-enter').slice(before)).toEqual([{ kind: 'focus-enter', event: focusEvent('first'), call: before + 1, caller: { plugin: PLUGIN, tier: 'user' } }])
    expect(values(h.receipts, 'public')).toEqual([{ kind: 'public', result: {} }])
    expect(values(h.receipts, 'nested-public')).toEqual([{ kind: 'nested-public', result: {} }])
    expect(values(h.receipts, 'observed-focus', OBSERVER).filter(value =>
      (value.event as { origin: { kind: string } }).origin.kind === 'plugin').map(value => value.caller)).toEqual([
      { plugin: PLUGIN, tier: 'user' }, { plugin: PLUGIN, tier: 'user' },
    ])
    expect(values(h.receipts, 'observed-focus', OBSERVER).filter(value =>
      (value.event as { origin: { kind: string } }).origin.kind === 'plugin').map(value => value.event)).toEqual([
      focusEvent('second'), focusEvent('first'),
    ])
    const result = await h.raw('\r', 1)
    expect(result.focusCalls).toBe(before + 1)
    expect(result.actions).toEqual([{ element: 'second' }])
    expect(values(h.receipts, 'action')).toHaveLength(1)
    expect(h.pane!.owner).toBe(owner)
    expect(h.paneRoot()).toBe(root)
    expect(h.pane!.focusedElement).toBe('second')
    clean(h)
  } finally { await h.dispose() }
})
