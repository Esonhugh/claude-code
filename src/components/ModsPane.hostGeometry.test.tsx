import {expect, test} from 'bun:test'
import chalk from 'chalk'
import RawText from '../ink/components/Text.js'
import React, {useEffect, useSyncExternalStore} from 'react'
import {Readable, Writable} from 'node:stream'
import {Box, Text, ThemeProvider, render} from '../ink.js'
import instances from '../ink/instances.js'
import {cellAt, type Screen} from '../ink/screen.js'
import {nodeCache} from '../ink/node-cache.js'
import type {DOMElement, DOMNode} from '../ink/dom.js'
import {dispatchClick} from '../ink/hit-test.js'
import {useTerminalSize} from '../hooks/useTerminalSize.js'
import {createModUi} from '../services/mods/ui.js'
import {FullscreenLayout} from './FullscreenLayout.js'
import {ModsPane} from './ModsPane.js'

class Output extends Writable {
  columns = 160; rows = 40; isTTY = true
  _write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {callback()}
}
class Input extends Readable {
  isTTY = true; isRaw = false
  _read() {}
  setRawMode(value: boolean) {this.isRaw = value; return this}
  ref() {return this}
  unref() {return this}
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 1500
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  expect(predicate()).toBe(true)
}
const presentation = {columns: 160, rows: 40, isFullscreen: true,
  composerEmpty: true, hasDialog: false, keyboardOwned: false}
function fixture(count = 40) {
  const owner = {}
  const drawings: unknown[] = []
  const ui = createModUi({pluginOf: () => 'fixture',
    dispatch: async (_owner, _event, input, core) => core(input),
    draw: async (_owner, input) => {drawings.push(input); return ({type: 'Box', props: {flexDirection: 'column'}, children:
      Array.from({length: count}, (_, i) => ({type: 'Text', children: ['BODY_' + i]}))})},
    invokeDrawing: async () => {}, releaseDrawing: async () => {},
  })
  return {owner, ui, drawings}
}
function element(stdout: Output, text: string, name: DOMElement['nodeName']): DOMElement | undefined {
  const ink = instances.get(stdout as never) as unknown as {rootNode: DOMElement} | undefined
  const contents = (node: DOMNode): string => node.nodeName === '#text' ? node.nodeValue : node.childNodes.map(contents).join('')
  let found: DOMElement | undefined
  const visit = (node: DOMElement) => {
    if (node.nodeName === name && contents(node) === text) found = node
    for (const child of node.childNodes) if (child.nodeName !== '#text') visit(child)
  }
  if (ink) visit(ink.rootNode)
  return found
}

test.each([
  [110, undefined, 39], [120, undefined, 49], [144, undefined, 63],
  [160, undefined, 71], [200, undefined, 89], [240, undefined, 89],
  [110, 1, 23], [110, 70, 70], [110, 1000, 85],
] as const)('official dock body at terminal %s, request %s is %s', async (columns, requested, bodyColumns) => {
  const {owner, ui, drawings} = fixture()
  await ui.open(owner, {id: 'geometry', ...(requested === undefined ? {} : {columns: requested})},
    {kind: 'person'}, {...presentation, columns})
  await ui.commit(owner)
  try {
    expect(ui.getSnapshot()[0]!.bodyColumns).toBe(bodyColumns)
    expect(drawings.at(-1)).toMatchObject({props: {bodyColumns}})
    await ui.render({...presentation, columns: 109})
    expect(ui.getSnapshot()[0]).toMatchObject({placement: 'inline', bodyColumns: 105})
    await ui.render({...presentation, columns})
    expect(ui.getSnapshot()[0]).toMatchObject({placement: 'dock', bodyColumns})
    expect(drawings.at(-1)).toMatchObject({props: {bodyColumns}})
  } finally {await ui.release(owner)}
})

test('actual fullscreen host height reserves its chrome above a full-width composer', async () => {
  const previous = process.env.CLAUDE_CODE_NO_FLICKER
  process.env.CLAUDE_CODE_NO_FLICKER = '1'
  const stdout = new Output(), {owner, ui} = fixture()
  let closes = 0, outsideClicks = 0
  await ui.open(owner, {id: 'geometry'}, {kind: 'person'}, presentation)
  await ui.commit(owner)
  function Width({label}: {label: string}) {
    const {columns} = useTerminalSize()
    return <Box width={columns}><Text>{label}</Text></Box>
  }
  function Host({composerRows}: {composerRows: number}) {
    const {columns, rows} = useTerminalSize()
    const panes = useSyncExternalStore(ui.subscribe, ui.getSnapshot)
    useEffect(() => {void ui.render({...presentation, columns, rows})}, [columns, rows])
    const dock = panes.find(pane => pane.visible && pane.placement === 'dock')
    return <Box width={columns} height={rows} flexDirection="column" onClick={() => outsideClicks++}>
      <FullscreenLayout scrollable={<Width label="TRANSCRIPT" />}
        bottom={<Box height={composerRows}><Width label="COMPOSER" /></Box>}
        dockWidth={dock ? dock.bodyColumns + 1 : undefined}
        dockPane={dock ? <ModsPane pane={dock}
          onReportMetrics={(pane, metrics) => ui.reportMetrics(pane.id, metrics)}
          onFocus={async () => ({})} onInteract={async () => {}} onScroll={async () => {}}
          onClose={async pane => {closes++; await ui.close(owner, pane.id, {kind: 'person'})}}
        /> : undefined} />
    </Box>
  }
  const instance = await render(<ThemeProvider><Host composerRows={3} /></ThemeProvider>,
    {stdout: stdout as never, stdin: new Input() as never, patchConsole: false, exitOnCtrlC: false})
  try {
    for (const composerRows of [3, 12, 20, 1]) {
      instance.rerender(<ThemeProvider><Host composerRows={composerRows} /></ThemeProvider>)
      await until(() => ui.getSnapshot()[0]?.bodyRows === stdout.rows - composerRows - 1)
      expect(ui.getSnapshot()[0]).toMatchObject({bodyColumns: 71, contentRows: 40})
      expect(element(stdout, 'COMPOSER', 'ink-box')!.yogaNode!.getComputedWidth()).toBe(160)
      expect(element(stdout, 'TRANSCRIPT', 'ink-box')!.yogaNode!.getComputedWidth()).toBe(88)
      expect(nodeCache.get(element(stdout, 'BODY_0', 'ink-text')!)?.y).toBe(1)
    }
    const close = nodeCache.get(element(stdout, '✕', 'ink-text')!)!
    expect(close).toMatchObject({x: 158, y: 0, width: 1, height: 1})
    const ink = instances.get(stdout as never) as unknown as {rootNode: DOMElement}
    expect(dispatchClick(ink.rootNode, close.x, close.y)).toBe(true)
    await until(() => closes === 1 && ui.getSnapshot().length === 0)
    expect(outsideClicks).toBe(0)
  } finally {
    instance.unmount(); await ui.release(owner)
    if (previous === undefined) delete process.env.CLAUDE_CODE_NO_FLICKER
    else process.env.CLAUDE_CODE_NO_FLICKER = previous
  }
})

test.each([[0, undefined, 0], [1, undefined, 1], [30, undefined, 11], [30, 1, 3], [30, 5, 5]] as const)('inline natural rows %s, request %s: %s after chrome', async (count, rows, expected) => {
    const stdout = new Output(), {owner, ui} = fixture(count)
    stdout.columns = 109
    await ui.open(owner, {id: 'geometry', ...(rows === undefined ? {} : {rows})},
      {kind: 'person'}, {...presentation, columns: 109})
    await ui.commit(owner)
    function Host() {
      const pane = useSyncExternalStore(ui.subscribe, ui.getSnapshot)[0]!
      return <Box width={109} height={40} flexDirection="column"><ModsPane pane={pane}
        onReportMetrics={(pane, metrics) => ui.reportMetrics(pane.id, metrics)}
        onFocus={async () => ({})} onClose={async () => {}} onInteract={async () => {}} onScroll={async () => {}}
      /></Box>
    }
    const instance = await render(<ThemeProvider><Host /></ThemeProvider>,
      {stdout: stdout as never, stdin: new Input() as never, patchConsole: false, exitOnCtrlC: false})
    try {
      await until(() => ui.getSnapshot()[0]?.bodyRows === expected && ui.getSnapshot()[0]?.contentRows === count)
      if (count) expect(nodeCache.get(element(stdout, 'BODY_0', 'ink-text')!)?.y).toBe(1)
    } finally {instance.unmount(); await ui.release(owner)}
  })


test('dock grip uses suggestion colour only while focused or directly hovered', async () => {
  const colorLevel = chalk.level
  chalk.level = 3
  const previous = process.env.CLAUDE_CODE_NO_FLICKER
  process.env.CLAUDE_CODE_NO_FLICKER = '1'
  const stdout = new Output()
  const host = (focused: boolean, visible = true) => <ThemeProvider><Box width={160} height={40} flexDirection="column">
    <FullscreenLayout dockWidth={72} dockFocused={focused}
      scrollable={<Box flexDirection="column" backgroundColor="composerSidebarBackground">
        <Text color="suggestion">LIT</Text><RawText dim>DIM</RawText>
      </Box>}
      dockPane={visible ? <Text>BODY</Text> : undefined} bottom={<Box height={3}><Text>COMPOSER</Text></Box>} />
  </Box></ThemeProvider>
  const instance = await render(host(true),
    {stdout: stdout as never, stdin: new Input() as never, patchConsole: false, exitOnCtrlC: false})
  const ink = instances.get(stdout as never) as unknown as {
    frontFrame: {screen: Screen}, setAltScreenActive(active: boolean, mouseTracking: boolean): void,
    dispatchHover(col: number, row: number): void,
  }
  const styles = (x: number, y: number) => {
    const screen = ink.frontFrame.screen
    return screen.stylePool.get(cellAt(screen, x, y).styleId).map(style => style.code).sort()
  }
  const matches = (text: string) => {
    const reference = nodeCache.get(element(stdout, text, 'ink-text')!)
    return reference && JSON.stringify(styles(88, 0)) === JSON.stringify(styles(reference.x, reference.y))
  }
  try {
    const lit = nodeCache.get(element(stdout, 'LIT', 'ink-text')!)!
    const dim = nodeCache.get(element(stdout, 'DIM', 'ink-text')!)!
    expect(styles(lit.x, lit.y).length).toBeGreaterThan(0)
    expect(styles(lit.x, lit.y)).not.toEqual(styles(dim.x, dim.y))
    expect(styles(88, 0)).toEqual(styles(lit.x, lit.y))
    await until(() => matches('LIT') === true)
    expect(cellAt(ink.frontFrame.screen, 88, 0).char).toBe('│')
    instance.rerender(host(false))
    await until(() => matches('DIM') === true)
    ink.setAltScreenActive(true, true)
    ink.dispatchHover(88, 0)
    await until(() => matches('LIT') === true)
    ink.dispatchHover(89, 0)
    await until(() => matches('DIM') === true)
    ink.dispatchHover(88, 0)
    await until(() => matches('LIT') === true)
    instance.rerender(host(false, false))
    await until(() => cellAt(ink.frontFrame.screen, 88, 0).char !== '│')
    instance.rerender(host(false))
    await until(() => matches('DIM') === true)
    instance.rerender(host(true))
    await until(() => matches('LIT') === true)
    ink.dispatchHover(-1, -1)
    await until(() => matches('LIT') === true)
  } finally {
    instance.unmount()
    chalk.level = colorLevel
    if (previous === undefined) delete process.env.CLAUDE_CODE_NO_FLICKER
    else process.env.CLAUDE_CODE_NO_FLICKER = previous
  }
})
