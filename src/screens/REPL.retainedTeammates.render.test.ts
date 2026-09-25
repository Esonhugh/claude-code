import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import * as React from 'react'
import ts from 'typescript'
import { Box, Text, ThemeProvider, render, useInput } from '../ink.js'
import { ModsPane } from '../components/ModsPane.js'
import { createModUi, type ModUiPresentation } from '../services/mods/ui.js'
import { getViewedAgentTask } from '../state/selectors.js'
import { AppStoreContext, getDefaultAppState } from '../state/AppState.js'
import { createStore } from '../state/store.js'
import { enterTeammateView } from '../state/teammateViewHelpers.js'
import { useBackgroundTaskNavigation } from '../hooks/useBackgroundTaskNavigation.js'
import type { AppState } from '../state/AppStateStore.js'
import type { DOMElement, DOMNode } from '../ink/dom.js'
import { getFocusManager } from '../ink/focus.js'
import instances from '../ink/instances.js'

process.env.NODE_ENV = 'test'

const source = readFileSync(new URL('./REPL.tsx', import.meta.url), 'utf8')
const file = ts.createSourceFile('REPL.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const fragments: ts.JsxFragment[] = []
function visit(node: ts.Node): void {
  if (ts.isJsxAttribute(node) && node.name.getText(file) === 'scrollable' &&
    node.initializer && ts.isJsxExpression(node.initializer) &&
    node.initializer.expression && ts.isJsxFragment(node.initializer.expression) &&
    node.initializer.expression.getText(file).includes('<LocalAgentSpinner')) {
    fragments.push(node.initializer.expression)
  }
  ts.forEachChild(node, visit)
}
visit(file)
expect(fragments).toHaveLength(1)
const children = fragments[0]!.children
const start = children.findIndex(node => ts.isJsxExpression(node) && node.getText(file).includes('<LocalAgentSpinner'))
expect(start).toBeGreaterThanOrEqual(0)
const jsx = `<>${children.slice(start).map(node => node.getText(file)).join('\n')}</>`
const js = ts.transpileModule(`const element = (${jsx});`, {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText
const evaluate = new Function('scope', `with (scope) { ${js}; return element; }`) as
  (scope: Record<string, unknown>) => React.ReactNode

async function renderBranch(bindings: Record<string, unknown> = {}) {
  let treeMounts = 0
  let spinnerMounts = 0
  const element = evaluate({
    React, Box,
    viewedAgentTask: undefined,
    isLocalAgentTask: () => false,
    showSpinner: false,
    isLoading: false,
    userInputOnProcessing: false,
    hasRunningTeammates: false,
    isBriefOnly: false,
    isFullscreenEnvEnabled: () => false,
    showTeammateTree: true,
    selectedIPAgentIndex: -1,
    viewSelectionMode: 'selecting-agent',
    toolJSX: undefined,
    toolUseConfirmQueue: [],
    promptQueue: [],
    pendingWorkerRequest: undefined,
    onlySleepToolActive: false,
    visibleStreamingText: undefined,
    SpinnerWithVerb: () => {
      spinnerMounts++
      return React.createElement(Text, null, 'ACTIVE_SPINNER')
    },
    LocalAgentSpinner: () => React.createElement(Text, null, 'LOCAL_SPINNER'),
    BriefIdleStatus: () => React.createElement(Text, null, 'BRIEF_IDLE'),
    TeammateSpinnerTree: () => {
      treeMounts++
      return React.createElement(Text, null, 'RETAINED_TREE')
    },
    ...bindings,
  })
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 40, isTTY: false })
  const stdin = Object.assign(new PassThrough(), { isTTY: false, setRawMode() {} })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  const app = await render(React.createElement(Box, null, element), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false, patchConsole: false,
  })
  try {
    expect(output).not.toContain('ERROR')
    return { output, treeMounts, spinnerMounts }
  } finally {
    app.unmount()
    app.cleanup()
  }
}

test('REPL child-view pane keeps stdin focus while selection and Escape retain navigation ownership', async () => {
  const declarations: ts.VariableDeclaration[] = []
  const effects: ts.CallExpression[] = []
  function findPresentation(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ['modUiPresentation', 'modPaneFocused', 'renderModPane'].includes(node.name.getText(file)))
      declarations.push(node)
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'useEffect' &&
        node.arguments[0]?.getText(file).includes('modsSession?.ui.render(modUiPresentation)'))
      effects.push(node)
    ts.forEachChild(node, findPresentation)
  }
  findPresentation(file)
  expect(declarations).toHaveLength(3)
  expect(effects).toHaveLength(1)
  const js = ts.transpileModule(`${declarations.map(node => `const ${node.getText(file)};`).join('\n')} modUiPresentationRef.current = modUiPresentation; ${effects[0]!.getText(file)};`, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  const evaluatePresentation = new Function('scope', `with (scope) { ${js}; return { renderModPane, modPaneFocused }; }`) as
    (scope: Record<string, unknown>) => {
      renderModPane: (pane: ReturnType<typeof ui.getSnapshot>[number]) => React.ReactNode
      modPaneFocused: boolean
    }
  const owner = { plugin: 'fixture' }
  const inputs: Record<string, unknown>[] = []
  const released: number[] = []
  const invoked: unknown[][] = []
  let focusDispatches = 0
  const ui = createModUi({
    pluginOf: () => 'fixture',
    dispatch: async (_owner, event, input, core) => {
      if (event === 'ui.focus') focusDispatches++
      return core(input)
    },
    draw: async (_owner, input) => {
      inputs.push(input)
      const props = input.props as { view: { agentId?: string } }
      return { type: 'Button', props: { key: 'view', label: props.view.agentId ?? 'main', hotkey: 'x' }, press: { plugin: 'fixture', handle: 1 } }
    },
    invokeDrawing: async (...args) => { invoked.push(args) },
    releaseDrawing: async (_owner, drawing) => { released.push(drawing) },
  })
  const initial: ModUiPresentation = {
    columns: 160, rows: 40, isFullscreen: true, composerEmpty: true, hasDialog: false, keyboardOwned: false,
  }
  await ui.open(owner, { id: 'persistent', focus: true }, { kind: 'person' }, initial)
  await ui.commit(owner)
  await ui.focus(owner, { requestId: 'persistent', element: 'view', origin: { kind: 'person' } })
  const tasks = {
    'actual-task-id': { id: 'actual-task-id', agentId: 'not-the-task-id', type: 'local_agent', status: 'completed', retain: true, messages: [] },
    teammate: { id: 'teammate', type: 'in_process_teammate', status: 'completed', retain: true, identity: { agentName: 'worker' }, messages: [] },
  } as unknown as AppState['tasks']
  const store = createStore<AppState>({ ...getDefaultAppState(), tasks })
  const errors: unknown[] = []
  const pending: Promise<void>[] = []
  const modsSession = { runtime: { ui }, ui: { render(presentation: ModUiPresentation) {
    const work = ui.render(presentation)
    pending.push(work)
    return work
  } } }
  const stableBindings: Record<string, unknown> = {
    React, ModsPane, useMemo: React.useMemo, useEffect: React.useEffect, modsSession,
    modUiPresentationRef: { current: initial },
    modTerminalSize: { columns: 160, rows: 40 }, isFullscreenEnvEnabled: () => true,
    pastedContents: {}, focusedInputDialog: undefined, toolJSX: undefined,
    showBashesDialog: false, exitFlow: undefined, isSearchingHistory: false, isHelpOpen: false,
    cursor: null, logError: (error: unknown) => { errors.push(error) },
  }
  let composerValue = ''
  let setComposerValue: React.Dispatch<React.SetStateAction<string>> = () => {}
  function Host() {
    const state = React.useSyncExternalStore(store.subscribe, store.getState)
    const panes = React.useSyncExternalStore(ui.subscribe, ui.getSnapshot)
    const [value, setValue] = React.useState('')
    composerValue = value
    setComposerValue = setValue
    const { renderModPane, modPaneFocused } = evaluatePresentation({
      ...stableBindings, inputValue: value, modPanes: panes, viewSelectionMode: state.viewSelectionMode,
      viewedAgentTask: getViewedAgentTask(state),
    })
    useBackgroundTaskNavigation()
    useInput(input => {
      if (/^[ -~]+$/.test(input)) setValue(previous => previous + input)
    }, { isActive: !modPaneFocused && value.length > 0 })
    return React.createElement(Box, null,
      panes.map(renderModPane),
      React.createElement(Text, null, `COMPOSER:${value}`),
    )
  }
  // Raw stdin is processed asynchronously by Ink, including Escape disambiguation.
  const settle = () => new Promise(resolve => setTimeout(resolve, 100))
  const stdout = Object.assign(new PassThrough(), { columns: 160, rows: 40, isTTY: false })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  stdout.resume()
  const app = await render(React.createElement(ThemeProvider, null,
    React.createElement(AppStoreContext.Provider, { value: store }, React.createElement(Host))), {
    stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false, exitOnCtrlC: false,
  })
  try {
    await settle()
    const ink = instances.get(stdout as never) as unknown as { rootNode: DOMElement }
    const focused = getFocusManager(ink.rootNode).activeElement
    expect(focused).toBeDefined()
    const textContent = (node: DOMNode): string => node.nodeName === '#text'
      ? node.nodeValue
      : node.childNodes.map(textContent).join('')
    const key = async (value: string) => { stdin.write(value); await settle() }
    const assertView = (agentId?: string) => {
      expect((inputs.at(-1)!.props as { view: object }).view).toEqual(agentId ? { agentId } : {})
      expect(ui.getSnapshot()).toHaveLength(1)
      expect(ui.getSnapshot()[0]).toMatchObject({ id: 'persistent', owner, focused: true, focusedElement: 'view' })
      expect(getFocusManager(ink.rootNode).activeElement).toBe(focused)
      expect(textContent(focused!)).toContain(agentId ?? 'main')
    }
    const press = async (value: string) => {
      const count = invoked.length
      const drawing = ui.getSnapshot()[0]!.drawing!
      await key(value)
      expect(invoked).toHaveLength(count + 1)
      expect(invoked.at(-1)?.slice(0, 3)).toEqual([owner, drawing, 1])
    }
    assertView()
    await press('\r')
    const drawing = ui.getSnapshot()[0]!.drawing!
    // The background-task dialog uses this same transition for local agents.
    enterTeammateView('actual-task-id', store.setState)
    await settle()
    expect(store.getState().viewSelectionMode).toBe('viewing-agent')
    assertView('actual-task-id')
    expect(ui.getSnapshot()[0]!.drawing).not.toBe(drawing)
    expect(released).toContain(drawing)
    await press('\r')
    await press('x')
    const focusCount = focusDispatches
    await key('\u001b')
    expect(focusDispatches).toBe(focusCount)
    expect(store.getState().viewSelectionMode).toBe('none')
    expect(store.getState().viewingAgentTaskId).toBeUndefined()
    assertView()

    // Exercise the production Shift+Down / Enter path, not a fabricated mode.
    await key('\u001b[1;2B')
    expect(store.getState().viewSelectionMode).toBe('selecting-agent')
    expect(getFocusManager(ink.rootNode).activeElement).not.toBe(focused)
    const count = invoked.length
    await key('x')
    expect(invoked).toHaveLength(count)
    await key('\u001b[1;2B')
    expect(store.getState().selectedIPAgentIndex).toBe(0)
    await key('\r')
    expect(store.getState().viewSelectionMode).toBe('viewing-agent')
    expect(store.getState().viewingAgentTaskId).toBe('teammate')
    expect(invoked).toHaveLength(count)
    // Selection intentionally relinquishes pane focus; Tab reacquires it.
    await key('\t')
    assertView('teammate')
    await press('\r')
    await press('x')
    const teammateFocusCount = focusDispatches
    await key('\u001b')
    expect(focusDispatches).toBe(teammateFocusCount)
    expect(store.getState().viewSelectionMode).toBe('none')
    assertView()

    // The composer surrogate is gated by the extracted production modPaneFocused value.
    // Its controlled value must receive real stdin and survive a main-child-main cycle.
    setComposerValue('draft:')
    await settle()
    expect(getFocusManager(ink.rootNode).activeElement).not.toBe(focused)
    const beforeTyping = invoked.length
    await key('main')
    expect(composerValue).toBe('draft:main')
    expect(invoked).toHaveLength(beforeTyping)
    enterTeammateView('actual-task-id', store.setState)
    await settle()
    expect(store.getState().viewSelectionMode).toBe('viewing-agent')
    expect(composerValue).toBe('draft:main')
    await key('-child')
    expect(composerValue).toBe('draft:main-child')
    expect(invoked).toHaveLength(beforeTyping)
    const typingFocusCount = focusDispatches
    await key('\u001b')
    expect(store.getState().viewSelectionMode).toBe('none')
    expect(composerValue).toBe('draft:main-child')
    expect(focusDispatches).toBe(typingFocusCount)
    expect(invoked).toHaveLength(beforeTyping)
    setComposerValue('')
    await settle()
    await key('\t')
    assertView()
    await press('\r')
    for (const [binding, blocked, unblocked] of [
      ['pastedContents', { paste: 'text' }, {}],
      ['focusedInputDialog', 'permission', undefined],
      ['isSearchingHistory', true, false],
      ['isHelpOpen', true, false],
      ['cursor', 0, null],
    ] as const) {
      stableBindings[binding] = blocked
      store.setState(previous => ({ ...previous }))
      await settle()
      expect(getFocusManager(ink.rootNode).activeElement).not.toBe(focused)
      const before = invoked.length
      await key('x')
      expect(invoked).toHaveLength(before)
      stableBindings[binding] = unblocked
      store.setState(previous => ({ ...previous }))
      await settle()
      await key('\t')
      assertView()
    }
    store.setState(previous => ({ ...previous, viewingAgentTaskId: 'missing' }))
    await settle()
    assertView()
    await Promise.all(pending)
    expect(errors).toEqual([])
  } finally {
    app.unmount()
    app.cleanup()
    await ui.release(owner)
  }
}, 15_000)

test('REPL mounts expanded teammate navigation while main is idle without starting a spinner', async () => {
  const result = await renderBranch()
  expect(result.spinnerMounts).toBe(0)
  expect(result.treeMounts).toBeGreaterThan(0)
  expect(result.output).toContain('RETAINED_TREE')
})

test('REPL does not mount idle navigation when collapsed or blocked by another UI', async () => {
  for (const bindings of [
    { showTeammateTree: false },
    { toolJSX: { showSpinner: false } },
    { toolUseConfirmQueue: [{}] },
    { promptQueue: [{}] },
    { pendingWorkerRequest: {} },
    { onlySleepToolActive: true },
    { visibleStreamingText: 'streaming' },
    { viewedAgentTask: {}, isLocalAgentTask: () => true, viewedAgentToolUseIDs: new Set(), verbose: false },
  ]) {
    const result = await renderBranch(bindings)
    expect(result.treeMounts).toBe(0)
    expect(result.spinnerMounts).toBe(0)
  }
})
