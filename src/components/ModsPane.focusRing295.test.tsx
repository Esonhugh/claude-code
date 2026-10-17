import { expect, test } from 'bun:test'
import chalk from 'chalk'
import React, { useLayoutEffect, useSyncExternalStore } from 'react'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { Terminal } from '@xterm/headless'
import ts from 'typescript'
import { render, ThemeProvider, useStdin, type DOMElement } from '../ink.js'
import type { DOMNode } from '../ink/dom.js'
import instances from '../ink/instances.js'
import { nodeCache } from '../ink/node-cache.js'
import { getFocusManager } from '../ink/focus.js'
import { ClockContext } from '../ink/components/ClockContext.js'
import { AlternateScreen } from '../ink/components/AlternateScreen.js'
import { createModsRuntime } from '../services/mods/runtime.js'
import { withModUiHostFocusOutcome } from '../services/mods/ui.js'
import { ModsPane } from './ModsPane.js'

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
  bytes: Buffer[] = []
  _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) {
    this.bytes.push(Buffer.from(chunk)); done()
  }
}
function textOf(node: DOMNode): string {
  return node.nodeName === '#text' ? node.nodeValue : node.childNodes.map(textOf).join('')
}
function find(root: DOMElement, label: string, painted = false): DOMElement | undefined {
  if (root.nodeName === 'ink-text' && textOf(root) === label && (!painted || nodeCache.has(root))) return root
  for (const child of root.childNodes) if (child.nodeName !== '#text') {
    const found = find(child, label, painted)
    if (found) return found
  }
}
function replFocus(scope: Record<string, unknown>): React.ComponentProps<typeof ModsPane>['onFocus'] {
  const source = readFileSync(new URL('../screens/REPL.tsx', import.meta.url), 'utf8')
  const file = ts.createSourceFile('REPL.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const callbacks: ts.Expression[] = []
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'renderModPane' && node.initializer) {
      const search = (child: ts.Node) => {
        if (ts.isJsxAttribute(child) && child.name.getText(file) === 'onFocus' &&
            child.initializer && ts.isJsxExpression(child.initializer) && child.initializer.expression)
          callbacks.push(child.initializer.expression)
        ts.forEachChild(child, search)
      }
      search(node.initializer)
    }
    ts.forEachChild(node, visit)
  }
  visit(file); expect(callbacks).toHaveLength(1)
  const code = ts.transpileModule('const callback=(' + callbacks[0]!.getText(file) + ');', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  return new Function('scope', 'with(scope){' + code + ';return callback;}')(scope)
}

async function mount(policy: 'accept' | 'deny-engine' | 'withhold-engine' = 'accept', duplicate = false,
  { autoFocus = true, otherPane = false, empty = false, tall = false }:
  { autoFocus?: boolean; otherPane?: boolean; empty?: boolean; tall?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mods-focus295-'))
  const entry = join(root, 'register.ts')
  await writeFile(entry, `export function register(on) {
    on('session.start',async($,e,next)=>{
      ${otherPane ? "await $.ui.open({id:'secondary',title:'Secondary',rows:6});" : ''}
      await $.ui.open({id:'ring',focus:true,rows:6});return next(e)});
    on('ui.focus',async($,e,next)=>{
      await $.ui.log('focus:'+JSON.stringify(e));
      if(e.origin.kind==='person' && e.element===undefined) {
        ${policy === 'deny-engine' ? "return {deny:'engine denied'}" : policy === 'withhold-engine' ? 'return {}' : ''}
      }
      return next(e);
    });
    on('ui.press',async($,e,next)=>{await $.ui.log('dispatch:'+e.element);return next(e)});
    on('ui.scroll',async($,e,next)=>{await $.ui.log('scroll:'+e.by);return next(e)});
    on('ui.render',{component:'Pane'},($,e)=>{
      const {Box,Text,Button}=$.ui.resolve(e);
      ${empty ? 'return Box({children:[]});' : ''}
      return Box({flexDirection:'column',flexShrink:0,children:[
        Button({key:${JSON.stringify(duplicate ? 'shared' : 'save')},${autoFocus ? 'autoFocus:true,' : ''}
          children:['Save ',Text({dimColor:true,children:'2m'})],
          onPress:async()=>{await $.ui.log('callback:save')}}),
        Button({key:${JSON.stringify(duplicate ? 'shared' : 'other')},label:'Other control',
          onPress:async()=>{await $.ui.log('callback:other')}}),
        ${tall ? "...Array.from({length:60},(_,i)=>Text({children:'overflow '+i}))" : ''}
      ]});
    });
  }`)
  const logs: string[] = [], diagnostics: unknown[] = [], errors: unknown[] = []
  const presentation = { columns: 160, rows: 40, isFullscreen: true, composerEmpty: true, hasDialog: false, keyboardOwned: false }
  const runtime = createModsRuntime({ onDiagnostic: e => diagnostics.push(e), services: {
    uiPresentation: () => presentation, uiLog: (_plugin, value) => logs.push(value),
  } })
  const onFocus = replFocus({ modsSession: { runtime }, modUiPresentationRef: { current: presentation }, withModUiHostFocusOutcome })
  const stdin = new Input(), stdout = new Output()
  const colorLevel = chalk.level
  chalk.level = 3
  let committedRevision = -1, committedDrawing: number | undefined, observed = 0, pointers = 0
  let observeFirst: (() => void) | undefined
  let instance: Awaited<ReturnType<typeof render>> | undefined
  let time = 0
  const clock = { now: () => time, subscribe: () => () => {}, setTickInterval: () => {}, setTimeout: () => () => {} }
  function Host() {
    const panes = useSyncExternalStore(runtime.ui.subscribe, runtime.ui.getSnapshot)
    const pane = panes.find(pane => pane.id === 'ring')
    const { setRawMode, internal_eventEmitter } = useStdin()
    useLayoutEffect(() => {
      setRawMode(true)
      const watch = () => { observed++ }
      const watchPointer = () => { pointers++ }
      observeFirst = () => {
        internal_eventEmitter.removeListener('input', watch)
        internal_eventEmitter.prependListener('input', watch)
        internal_eventEmitter.removeListener('pointer', watchPointer)
        internal_eventEmitter.prependListener('pointer', watchPointer)
      }
      observeFirst()
      return () => {
        observeFirst = undefined
        internal_eventEmitter.removeListener('input', watch)
        internal_eventEmitter.removeListener('pointer', watchPointer)
        setRawMode(false)
      }
    }, [internal_eventEmitter, setRawMode])
    useLayoutEffect(() => { committedRevision = pane?.revision ?? -1; committedDrawing = pane?.drawing })
    return <>{panes.map(pane => <ModsPane key={pane.id} pane={pane} onFocus={onFocus}
      onInteract={(pane, drawing, callback, kind, element, value) => runtime.ui.interact(pane.id, drawing, callback, kind, element, value)}
      onClose={pane => runtime.ui.close(pane.owner, pane.id, { kind: 'person' })}
      onScroll={(pane, by) => runtime.ui.scroll(pane.owner, { requestId: pane.id, by, origin: { kind: 'person' } })}
      onReportMetrics={(pane, metrics) => runtime.ui.reportMetrics(pane.id, metrics)} onError={error => errors.push(error)} />)}</>
  }
  const until = async (predicate: () => boolean, description = 'state') => {
    const deadline = performance.now() + 1800
    while (!predicate() && performance.now() < deadline) await new Promise(resolve => setImmediate(resolve))
    expect(errors).toEqual([]); expect(diagnostics).toEqual([])
    expect(predicate(), description).toBe(true)
  }
  const dom = () => (instances.get(stdout as never) as unknown as { rootNode: DOMElement }).rootNode
  const pane = () => runtime.ui.getSnapshot().find(pane => pane.id === 'ring')!
  const panes = () => runtime.ui.getSnapshot()
  const settled = () => pane()?.revision === committedRevision && pane()?.drawing === committedDrawing
  const count = (name: string) => logs.filter(line => line === 'callback:' + name).length
  const focusEvents = () => logs.filter(line => line.startsWith('focus:')).map(line => JSON.parse(line.slice(6)))
  const send = async (bytes: string, eventCount: number, pointer = false) => {
    await runtime.settle(); await until(settled)
    const before = pointer ? pointers : observed; observeFirst!(); stdin.push(bytes)
    await until(() => (pointer ? pointers : observed) === before + eventCount, 'all parsed inputs observed')
    await runtime.settle()
  }
  const inverse = async (label: string) => {
    const terminal = new Terminal({ cols: stdout.columns, rows: stdout.rows, allowProposedApi: true })
    try {
      await new Promise<void>(resolve => terminal.write(Buffer.concat(stdout.bytes), resolve))
      const rows = Array.from({ length: terminal.rows }, (_, row) => terminal.buffer.active.getLine(terminal.buffer.active.baseY + row)?.translateToString(true) ?? '')
      const y = rows.findIndex(row => row.includes(label)); expect(y, label + ' physically painted').toBeGreaterThanOrEqual(0)
      const x = rows[y]!.indexOf(label), line = terminal.buffer.active.getLine(terminal.buffer.active.baseY + y)!
      return Array.from({ length: label.length }, (_, offset) => Boolean(line.getCell(x + offset)?.isInverse()))
    } finally { terminal.dispose() }
  }
  const expectInverse = async (label: string, value: boolean) => {
    const deadline = performance.now() + 1800
    let cells = await inverse(label)
    while (cells.some(cell => cell !== value) && performance.now() < deadline) {
      await new Promise(resolve => setImmediate(resolve))
      cells = await inverse(label)
    }
    if (cells.some(cell => cell !== value)) console.error(JSON.stringify({ label, expected: value,
      pane: { focused: pane().focused, element: pane().focusedElement, drawing: pane().drawing, revision: pane().revision },
      active: getFocusManager(dom()).activeElement ? textOf(getFocusManager(dom()).activeElement!) : null,
      saveStyle: find(dom(), '[ Save 2m ]')?.textStyles, otherStyle: find(dom(), '[ Other control ]')?.textStyles,
      focus: focusEvents(),
    }))
    expect(cells).toEqual(Array(label.length).fill(value))
  }
  const clickSave = async () => {
    const node = find(dom(), '[ Save 2m ]')!, rect = nodeCache.get(node)!
    expect(rect).toBeDefined(); time = 300
    const x = rect.x + '[ Save 2m ]'.indexOf('2m') + 1, y = rect.y + 1
    await send('\x1b[<0;' + x + ';' + y + 'M\x1b[<0;' + x + ';' + y + 'm', 2, true)
  }
  const dispose = async () => {
    instance?.unmount(); instance?.cleanup(); stdin.destroy(); stdout.destroy()
    await runtime.dispose(); await rm(root, { recursive: true, force: true })
    chalk.level = colorLevel
  }
  try {
    await runtime.bind({ cwd: root, surface: 'terminal', isInteractive: true, sessionId: 'focus-ring-295' })
    instance = await render(<ClockContext.Provider value={clock}><ThemeProvider><AlternateScreen><Host /></AlternateScreen></ThemeProvider></ClockContext.Provider>, {
      stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false,
    })
    await runtime.reconcile([{ name: 'ring', storageId: 'ring@test', pluginRoot: root, entrypoints: [entry] }])
    await until(() => pane()?.focused && pane()?.focusedElement === (autoFocus ? duplicate ? 'shared' : 'save' : undefined) && settled())
    const closeSecondary = async () => {
      const pane = panes().find(pane => pane.id === 'secondary')!
      await runtime.ui.close(pane.owner, pane.id, { kind: 'person' })
    }
    const hover = async (label: string) => {
      await until(() => find(dom(), label, true) !== undefined, 'visible painted pointer target')
      const node = find(dom(), label, true)!, rect = nodeCache.get(node)!
      expect(rect).toBeDefined()
      await send(`\x1b[<35;${rect.x + 1};${rect.y + 1}M`, 1, true)
    }
    return { pane, panes, logs, until, count, focusEvents, send, expectInverse, clickSave, closeSecondary, hover, dispose }
  } catch (error) { await dispose(); throw error }
}

test('official 295 mouse press retains the distinct custom keyboard Button and its painted chrome', async () => {
  const h = await mount()
  try {
    await h.send('\t\r', 2); await h.until(() => h.count('other') === 1)
    const before = h.focusEvents().length
    await h.clickSave(); await h.until(() => h.count('save') === 1)
    expect(h.pane()).toMatchObject({ focused: true, focusedElement: 'other' })
    expect(h.focusEvents()).toHaveLength(before)
    await h.expectInverse('[ Save 2m ]', false)
    await h.expectInverse('[ Other control ]', true)
    await h.send('\r', 1); await h.until(() => h.count('other') === 2)
    expect(h.count('save')).toBe(1)
  } finally { await h.dispose() }
})

test('Pane Tab reaches the held close slot, ShiftTab returns, and a same-read Tab Enter closes', async () => {
  const h = await mount()
  try {
    await h.send('\t\r', 2); await h.until(() => h.count('other') === 1)
    await h.send('\t', 1); await h.until(() => h.pane().focused && h.pane().focusedElement === undefined, 'held engine close slot')
    await h.expectInverse('[ Save 2m ]', false)
    await h.expectInverse('[ Other control ]', false)
    await h.expectInverse('✕', true)
    await h.send('\x1b[Z\r', 2); await h.until(() => h.count('other') === 2)
    expect(h.pane()).toMatchObject({ focused: true, focusedElement: 'other' })
    await h.send('\t\r', 2); await h.until(() => !h.pane()?.visible)
    expect(h.count('save')).toBe(0); expect(h.count('other')).toBe(2)
  } finally { await h.dispose() }
})

test('Pane Up Down wrap through controls and skip the engine close slot', async () => {
  const h = await mount()
  try {
    await h.send('\x1b[A\r', 2); await h.until(() => h.count('other') === 1)
    await h.send('\x1b[B\r', 2); await h.until(() => h.count('save') === 1)
    expect(h.pane()).toMatchObject({ focused: true, focusedElement: 'save', visible: true })
  } finally { await h.dispose() }
})

test('a scrollable Worker Pane gives Up Down to scrolling and retains its custom control', async () => {
  const h = await mount('accept', false, { tall: true })
  try {
    await h.until(() => h.pane().contentRows > h.pane().bodyRows)
    const before = h.focusEvents().length
    await h.send('\x1b[B\x1b[A', 2)
    await h.until(() => h.logs.filter(line => line.startsWith('scroll:')).length === 2)
    expect(h.logs.filter(line => line.startsWith('scroll:'))).toEqual(['scroll:1', 'scroll:-1'])
    expect(h.pane()).toMatchObject({ focused: true, focusedElement: 'save', scrollOffset: 0 })
    expect(h.focusEvents()).toHaveLength(before)
    await h.expectInverse('[ Save 2m ]', true)
    await h.expectInverse('[ Other control ]', false)
  } finally { await h.dispose() }
})

test('an empty unscrollable Worker Pane consumes arrows without issuing scroll or control focus', async () => {
  const h = await mount('accept', false, { empty: true, autoFocus: false })
  try {
    await h.until(() => h.pane().contentRows <= h.pane().bodyRows)
    const before = h.focusEvents().length
    await h.send('\x1b[B\x1b[A', 2)
    expect(h.logs.filter(line => line.startsWith('scroll:'))).toEqual([])
    expect(h.focusEvents()).toHaveLength(before)
    expect(h.pane()).toMatchObject({ focused: true, scrollOffset: 0 })
    await h.send('\t\r', 2); await h.until(() => !h.pane()?.visible)
  } finally { await h.dispose() }
})

test('same-plugin duplicate keys keep custom chrome and activation on the acknowledged DOM slot', async () => {
  const h = await mount('accept', true)
  try {
    await h.send('\t\r', 2); await h.until(() => h.count('other') === 1)
    await h.clickSave(); await h.until(() => h.count('save') === 1)
    await h.expectInverse('[ Save 2m ]', false)
    await h.expectInverse('[ Other control ]', true)
    await h.send('\r', 1); await h.until(() => h.count('other') === 2)
    expect(h.count('save')).toBe(1)
  } finally { await h.dispose() }
})

for (const policy of ['deny-engine', 'withhold-engine'] as const) test('engine focus preserves real ' + policy + ' negotiation and activation', async () => {
  const h = await mount(policy)
  try {
    await h.send('\t\r', 2); await h.until(() => h.count('other') === 1)
    await h.send('\t\r', 2); await h.until(() => h.count('other') === 2)
    expect(h.focusEvents().some(event => event.origin.kind === 'person' && event.element === undefined)).toBe(true)
    expect(h.pane()).toMatchObject({ focused: true, focusedElement: 'other', visible: true })
    await h.expectInverse('[ Other control ]', true)
    await h.expectInverse('✕', false)
  } finally { await h.dispose() }
})

test('ShiftTab from an unselected Pane starts at its final close slot', async () => {
  const h = await mount('accept', false, { autoFocus: false })
  try {
    await h.send('\x1b[Z', 1)
    await h.expectInverse('✕', true)
    await h.send('\r', 1); await h.until(() => !h.pane()?.visible)
    expect(h.count('save') + h.count('other')).toBe(0)
  } finally { await h.dispose() }
})

test('Pane Tab includes the other Pane tab before close and Enter picks that identity', async () => {
  const h = await mount('accept', false, { otherPane: true })
  try {
    await h.expectInverse(' ring ', true)
    await h.expectInverse(' Secondary ', false)
    await h.hover(' Secondary ')
    await h.expectInverse(' Secondary ', true)
    await h.hover('[ Save 2m ]')
    await h.expectInverse(' Secondary ', false)
    await h.send('\t\t', 2)
    await h.until(() => h.pane().focused && h.pane().focusedElement === undefined)
    await h.expectInverse(' Secondary ', true)
    await h.expectInverse('✕', false)
    await h.send('\r', 1)
    await h.until(() => h.panes().some(pane => pane.id === 'secondary' && pane.focused && pane.shown))
    expect(h.pane()).toMatchObject({ focused: false, shown: false })
    expect(h.count('save') + h.count('other')).toBe(0)
  } finally { await h.dispose() }
})

test('the held close slot keeps its identity when another Pane disappears', async () => {
  const h = await mount('accept', false, { otherPane: true })
  try {
    await h.send('\t\t\t', 3)
    await h.until(() => h.pane().focused && h.pane().focusedElement === undefined)
    await h.expectInverse('✕', true)
    await h.closeSecondary()
    await h.until(() => h.panes().length === 1)
    await h.expectInverse('✕', true)
    await h.send('\r', 1); await h.until(() => !h.pane()?.visible)
    expect(h.count('save') + h.count('other')).toBe(0)
  } finally { await h.dispose() }
})
